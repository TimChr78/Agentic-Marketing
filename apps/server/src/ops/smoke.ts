import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';

// `am smoke`: post-install and post-upgrade checks from outside the container.
//
// Deliberately a plain HTTP client: it must run with `docker compose exec app am smoke` and in CI,
// so it loads no config, database or server code. Every request has a short timeout and a failed
// check is data, not an exception, so one broken area does not hide the rest.

const TIMEOUT_MS = 5_000;

type Status = 'pass' | 'fail' | 'skip';
type Check = { id: string; status: Status; detail: string };
type Target = { origin: string; prefix: string; url: URL };
type RpcReply = {
  status: number;
  sessionId?: string;
  message?: RpcMessage;
  result?: Record<string, unknown>;
  error?: RpcMessage['error'];
  text: string;
};
type RpcMessage = {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
};
type SystemStatus = {
  serverVersion: string;
  emailProvider: {
    configured: boolean;
    marketing: boolean;
    transactional: boolean;
    adapter: string | null;
    tracking: string | null;
  };
};

const USAGE = `usage: am smoke --public-url URL [--admin-url URL] [--token amk_…] [--form FORM_ID] [--email ADDRESS] [--cleanup] [--asset PATH] [--json]

  --public-url  public listener, e.g. https://links.example.com or https://example.com/am
  --admin-url   admin listener, e.g. http://localhost:3000
  --token       API token (or set AM_TOKEN) with artifacts:read; add profiles:read for --cleanup
  --form        published form id (frm_…) for a signup round trip
  --email       address that should receive the signup confirmation
  --cleanup     with --form and --email, try to erase the profile the signup created
  --asset       public asset path, e.g. /a/ast_…/logo.png
  --json        print { ok, checks } instead of a table

Checks a publicly reachable install: health and assets work, admin routes and dot-segment
traversal are hidden, MCP and the e-mail provider answer, and a form redirects as expected.
A signup check creates a real profile in the live workspace; a double opt-in form also sends a real e-mail.
Exits 1 if any check fails.`;

export async function run(args: string[]): Promise<number> {
  let values: {
    'public-url'?: string;
    'admin-url'?: string;
    token?: string;
    form?: string;
    email?: string;
    cleanup?: boolean;
    asset?: string;
    json?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'public-url': { type: 'string' },
        'admin-url': { type: 'string' },
        token: { type: 'string' },
        form: { type: 'string' },
        email: { type: 'string' },
        cleanup: { type: 'boolean' },
        asset: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`am smoke: ${messageOf(err)}\n\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values['public-url']) {
    console.error(USAGE);
    return 2;
  }

  const publicTarget = targetOf(values['public-url']);
  if (!publicTarget) {
    console.error('am smoke: --public-url must be an http:// or https:// URL');
    return 2;
  }
  const adminTarget = values['admin-url'] ? targetOf(values['admin-url']) : undefined;
  if (values['admin-url'] && !adminTarget) {
    console.error('am smoke: --admin-url must be an http:// or https:// URL');
    return 2;
  }

  // The flag wins over the environment so a one-off run can override a token in the container.
  const token = values.token?.trim() || process.env.AM_TOKEN?.trim() || undefined;
  const form = values.form?.trim() || undefined;
  const email = values.email?.trim() || undefined;
  const asset = values.asset?.trim() || undefined;
  const cleanup = values.cleanup === true;
  const checks: Check[] = [];

  await check(checks, 'public.health', undefined, async () => {
    const res = await fetch(publicTarget.origin + publicPath(publicTarget, '/healthz'), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    if (res.status !== 200) throw new Error(`GET /healthz returned HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { ok?: unknown; version?: unknown } | null;
    if (body?.ok !== true) throw new Error('GET /healthz did not return JSON with ok: true');
    const version = body.version === undefined ? '' : `, version ${String(body.version)}`;
    return `HTTP 200${version}`;
  });

  await check(checks, 'public.admin-hidden', undefined, async () => {
    const probes = [
      ['POST', '/v1/workspace.get'],
      ['POST', '/mcp'],
      ['GET', '/'],
      ['GET', '/api/auth/get-session'],
      ['GET', '/openapi.json'],
    ] as const;
    const wrong: string[] = [];
    for (const [method, path] of probes) {
      const res = await fetch(publicTarget.origin + publicPath(publicTarget, path), {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
      await res.body?.cancel();
      if (res.status !== 404) wrong.push(`${method} ${path} → ${res.status}`);
    }
    if (wrong.length) throw new Error(`expected 404; ${wrong.join('; ')}`);
    return 'admin API, MCP, UI, auth and OpenAPI all return 404 on the public URL';
  });

  await check(checks, 'public.dot-segments', undefined, async () => {
    // fetch normalises `..`, so these have to be written to the socket exactly as shown.
    const paths = ['/f/../v1/workspace.get', '/f/%2e%2e/v1/workspace.get', '/hooks/..%2fmcp'];
    const wrong: string[] = [];
    for (const path of paths) {
      const status = await rawStatus(publicTarget, publicPath(publicTarget, path), 'POST');
      if (status !== 400) wrong.push(`${path} → ${status}`);
    }
    if (wrong.length) throw new Error(`expected 400; ${wrong.join('; ')}`);
    return 'raw dot-segment and encoded-separator paths return 400';
  });

  await check(checks, 'public.assets', asset ? undefined : 'needs --asset PATH', async () => {
    const path = asset!.startsWith('/') ? asset! : `/${asset!}`;
    const res = await fetch(publicTarget.origin + publicPath(publicTarget, path), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    const contentType = res.headers.get('content-type') ?? '';
    await res.body?.cancel();
    if (res.status !== 200) throw new Error(`GET ${path} returned HTTP ${res.status}`);
    if (!contentType || /html/i.test(contentType))
      throw new Error(`GET ${path} returned ${contentType || 'no content-type'}, not an asset`);
    return `HTTP 200, ${contentType}`;
  });

  await check(checks, 'admin.health', adminTarget ? undefined : 'needs --admin-url', async () => {
    const res = await fetch(adminTarget!.origin + publicPath(adminTarget!, '/readyz'), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    await res.body?.cancel();
    if (res.status !== 200) throw new Error(`GET /readyz returned HTTP ${res.status}`);
    // The version is useful, but the token may not be able to read status; health still passes then.
    const status = token ? await systemStatus(adminTarget!, token).catch(() => null) : null;
    return status ? `HTTP 200, server ${status.serverVersion}` : 'HTTP 200';
  });

  await check(checks, 'admin.mcp', adminTarget ? (token ? undefined : 'needs --token or AM_TOKEN') : 'needs --admin-url', async () => {
    const init = await mcpRequest(adminTarget!, token!, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'am-smoke', version: '1' },
      },
    });
    if (init.status < 200 || init.status >= 300) throw new Error(`initialize returned HTTP ${init.status}${rpcSuffix(init)}`);
    if (init.error) throw new Error(`initialize failed: ${rpcError(init)}`);
    if (!init.result) throw new Error('initialize returned no JSON-RPC result');

    const protocolVersion = typeof init.result.protocolVersion === 'string' ? init.result.protocolVersion : '2025-11-25';
    const sessionId = init.sessionId;

    const ack = await mcpRequest(adminTarget!, token!, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, protocolVersion);
    if (ack.status < 200 || ack.status >= 300) throw new Error(`notifications/initialized returned HTTP ${ack.status}${rpcSuffix(ack)}`);

    const list = await mcpRequest(
      adminTarget!,
      token!,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      sessionId,
      protocolVersion,
    );
    if (list.status < 200 || list.status >= 300) throw new Error(`tools/list returned HTTP ${list.status}${rpcSuffix(list)}`);
    if (list.error) throw new Error(`tools/list failed: ${rpcError(list)}`);
    const tools = list.result?.tools;
    if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');
    if (tools.length === 0) throw new Error('MCP exposes no tools for this token');
    return `${tools.length} tools available`;
  });

  await check(checks, 'admin.provider', adminTarget ? (token ? undefined : 'needs --token or AM_TOKEN') : 'needs --admin-url', async () => {
    const status = await systemStatus(adminTarget!, token!);
    const { marketing, transactional, adapter } = status.emailProvider;
    const missing = [!marketing ? 'marketing' : '', !transactional ? 'transactional' : ''].filter(Boolean);
    if (missing.length)
      throw new Error(`no enabled e-mail provider for ${missing.length === 2 ? 'marketing and transactional' : missing[0]} mail`);
    return `${adapter ?? 'unknown'} provider configured for marketing and transactional mail`;
  });

  await check(
    checks,
    'public.signup',
    !form || !email
      ? 'needs --form and --email'
      : cleanup && (!adminTarget || !token)
        ? 'needs --admin-url and --token for --cleanup'
        : undefined,
    async () => {
      const body = new URLSearchParams({ email: email! }).toString();
      const res = await fetch(publicTarget.origin + publicPath(publicTarget, `/f/${form}`), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (res.status !== 303) throw new Error(`POST /f/${form} returned HTTP ${res.status}${location ? `, Location ${location}` : ''}`);
      if (!location) throw new Error(`POST /f/${form} returned 303 without a Location header`);
      const detail = `303 → ${location}; a confirmation e-mail should arrive at ${email}`;
      if (!cleanup) return detail;
      return `${detail}; ${await cleanupSignupProfile(adminTarget!, token!, email!)}`;
    },
  );

  const ok = checks.every((c) => c.status !== 'fail');
  if (values.json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    printTable(checks);
    const passed = checks.filter((c) => c.status === 'pass').length;
    const failed = checks.filter((c) => c.status === 'fail').length;
    const skipped = checks.filter((c) => c.status === 'skip').length;
    console.log(`${checks.length} checks: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  }
  return ok ? 0 : 1;
}

async function check(checks: Check[], id: string, skip: string | undefined, fn: () => Promise<string>): Promise<void> {
  if (skip) {
    checks.push({ id, status: 'skip', detail: skip });
    return;
  }
  try {
    checks.push({ id, status: 'pass', detail: await fn() });
  } catch (err) {
    checks.push({ id, status: 'fail', detail: messageOf(err) });
  }
}

function printTable(checks: Check[]): void {
  const statusWidth = Math.max('STATUS'.length, ...checks.map((c) => c.status.length));
  const idWidth = Math.max('CHECK'.length, ...checks.map((c) => c.id.length));
  console.log(`${'STATUS'.padEnd(statusWidth)}  ${'CHECK'.padEnd(idWidth)}  DETAIL`);
  for (const c of checks) console.log(`${c.status.padEnd(statusWidth)}  ${c.id.padEnd(idWidth)}  ${c.detail}`);
}

function targetOf(raw: string): Target | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return { origin: `${url.protocol}//${url.host}`, prefix: url.pathname.replace(/\/+$/, ''), url };
}

/** Public paths live under the prefix when a site proxies /am/* to the listener. */
function publicPath(target: Target, path: string): string {
  return `${target.prefix}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Send the path verbatim; fetch and most clients would collapse the dot segments first. */
function rawStatus(target: Target, path: string, method: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const transport = target.url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: target.url.hostname,
        port: target.url.port || undefined,
        path,
        method,
        headers: { connection: 'close' },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          settled = true;
          resolve(res.statusCode ?? 0);
        });
        res.on('error', (err) => {
          if (!settled) reject(err);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
    req.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

async function mcpRequest(
  target: Target,
  token: string,
  payload: unknown,
  sessionId?: string,
  protocolVersion?: string,
): Promise<RpcReply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;

  const res = await fetch(target.origin + publicPath(target, '/mcp'), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'manual',
  });
  const text = await res.text();
  const message = rpcMessage(text, res.headers.get('content-type') ?? '');
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id') ?? undefined,
    message,
    result: message?.result,
    error: message?.error,
    text,
  };
}

function rpcMessage(text: string, contentType: string): RpcMessage | undefined {
  const payloads = /text\/event-stream/i.test(contentType) ? ssePayloads(text) : [text];
  let last: RpcMessage | undefined;
  for (const payload of payloads) {
    const trimmed = payload.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RpcMessage | RpcMessage[];
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (message && typeof message === 'object') last = message;
      }
    } catch {
      // A non-JSON event is not a JSON-RPC reply; keep looking for one.
    }
  }
  return last;
}

function ssePayloads(text: string): string[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter(Boolean);
}

function rpcError(reply: RpcReply): string {
  const error = reply.message?.error;
  if (!error) return `unexpected reply${bodySuffix(reply.text)}`;
  return `${String(error.message ?? error.code ?? 'unknown JSON-RPC error')}${bodySuffix(reply.text)}`;
}

function rpcSuffix(reply: RpcReply): string {
  return reply.error ? `: ${rpcError(reply)}` : bodySuffix(reply.text);
}

function bodySuffix(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine ? ` (${oneLine.slice(0, 200)})` : '';
}

/** Call an admin command with a token; the REST surface returns the output directly. */
async function restCommand(target: Target, token: string, command: string, input: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(target.origin + publicPath(target, `/v1/${command}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'manual',
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`POST /v1/${command} returned HTTP ${res.status}${bodySuffix(text)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${command} returned non-JSON`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${command} returned unexpected JSON`);
  return body as Record<string, unknown>;
}

async function systemStatus(target: Target, token: string): Promise<SystemStatus> {
  const body = await restCommand(target, token, 'system.status', {});
  const provider = body.emailProvider;
  if (typeof body.serverVersion !== 'string' || !provider || typeof provider !== 'object' || Array.isArray(provider))
    throw new Error('system.status returned an unexpected body');
  const p = provider as Record<string, unknown>;
  if (typeof p.configured !== 'boolean' || typeof p.marketing !== 'boolean' || typeof p.transactional !== 'boolean')
    throw new Error('system.status returned an unexpected body');
  return {
    serverVersion: body.serverVersion,
    emailProvider: {
      configured: p.configured,
      marketing: p.marketing,
      transactional: p.transactional,
      adapter: typeof p.adapter === 'string' ? p.adapter : null,
      tracking: typeof p.tracking === 'string' ? p.tracking : null,
    },
  };
}

/** Erase the profile a signup created, or say plainly why it is still there. */
async function cleanupSignupProfile(target: Target, token: string, email: string): Promise<string> {
  const leftInPlace =
    'left in place: erase with profiles.erase or let the unconfirmed-signup retention (RETENTION_UNCONFIRMED_DAYS) remove it';
  let profileId: string | null = null;
  try {
    // The public listener only queues the event; a worker creates the profile shortly afterwards.
    for (let attempt = 0; attempt < 10 && !profileId; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200));
      const found = await restCommand(target, token, 'profiles.find', { type: 'email', value: email });
      profileId = typeof found.profileId === 'string' ? found.profileId : null;
    }
  } catch (err) {
    return `${leftInPlace} (could not look it up: ${messageOf(err)})`;
  }
  if (!profileId) return 'no profile found to erase';
  try {
    await restCommand(target, token, 'profiles.erase', { profileId, reason: 'am smoke signup cleanup' });
    return `profile ${profileId} erased`;
  } catch (err) {
    return `profile ${profileId} ${leftInPlace} (${messageOf(err)})`;
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `timed out after ${TIMEOUT_MS / 1000} s`;
    const base = err.message || err.name;
    const cause = causeText(err.cause);
    return cause ? `${base}: ${cause}` : base;
  }
  return String(err);
}

/** Node puts the useful part of a network failure in `err.cause`; "fetch failed" alone hides it. */
function causeText(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof AggregateError) {
    const parts = cause.errors.map(causeText).filter((part): part is string => !!part);
    return parts.length ? parts.join('; ') : describeError(cause);
  }
  if (cause instanceof Error) return describeError(cause);
  return String(cause);
}

function describeError(err: Error): string {
  const code = (err as Error & { code?: unknown }).code;
  const message = err.message || err.name;
  const text = typeof code === 'string' && !message.includes(code) ? `${code} ${message}` : message;
  const nested = causeText(err.cause);
  return nested ? `${text}: ${nested}` : text;
}
