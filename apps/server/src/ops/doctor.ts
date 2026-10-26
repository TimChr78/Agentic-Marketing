import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type Check, checkConfig, envFileChecks, envFileValues, liveChecks, offlineChecks } from './checks';

// `am doctor`: check this install without changing it. Offline checks always run; live checks run
// only when the configuration is valid, and every network operation has a short timeout.

const TEMPLATE = new URL('../../../../.env.example', import.meta.url);

const USAGE = `usage: am doctor [--json] [--env-file PATH|-] [--from VERSION]

Checks this install without changing it: secrets, URLs, the public listener, trusted proxies,
Postgres and its migrations, ClickHouse, NATS, Valkey, sending-domain SPF/DMARC and egress.
It exits 1 when a check fails; warnings and notes do not fail it.

  --env-file PATH  Also compare PATH with .env.example. Use - to read it from stdin.
  --from VERSION   The release the file comes from (default: its AM_VERSION); only variables
                   added after that release are reported.
  --json           Print the checks as JSON.`;

function printTable(checks: Check[]) {
  const statusWidth = Math.max('STATUS'.length, ...checks.map((check) => check.status.length));
  const idWidth = Math.max('CHECK'.length, ...checks.map((check) => check.id.length));
  const row = (status: string, id: string, message: string, hint = '') =>
    `${status.padEnd(statusWidth)}  ${id.padEnd(idWidth)}  ${message}${hint ? `  (${hint})` : ''}`;
  console.log(row('STATUS', 'CHECK', 'MESSAGE', 'HINT'));
  for (const check of checks) console.log(row(check.status, check.id, check.message, check.hint));
  const count = (status: Check['status']) => checks.filter((check) => check.status === status).length;
  console.log(`\n${count('ok')} ok, ${count('warn')} warning(s), ${count('info')} info, ${count('fail')} failure(s)`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** Say why a file cannot be read: missing and permission-denied need different fixes. */
async function unreadableCheck(label: string, err: unknown): Promise<Check> {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT')
    return {
      id: 'env-file',
      status: 'fail',
      message: `${label} not found`,
      hint: 'Pass the path to the .env you are upgrading from, or use --env-file - < .env.',
    };
  if (code === 'EACCES' || code === 'EPERM') {
    let details = '';
    try {
      // The owner and mode explain a mount made by root for a container that runs as another uid.
      const info = await stat(label);
      const mode = (info.mode & 0o777).toString(8).padStart(4, '0');
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      details = ` (owner uid ${info.uid}, mode ${mode}${uid === undefined ? '' : `; this container runs as uid ${uid}`})`;
    } catch {
      // Statting can fail for the same reason as reading; the message without details still helps.
    }
    return {
      id: 'env-file',
      status: 'fail',
      message: `can't read ${label}${details} — use --env-file - < .env`,
      hint: 'Read it from stdin instead: it needs no mount and works whatever the file owner and mode.',
    };
  }
  return {
    id: 'env-file',
    status: 'fail',
    message: `cannot read ${label}: ${err instanceof Error ? err.message : String(err)}`,
    hint: 'Pass the path to an existing .env file, or use --env-file - < .env.',
  };
}

async function readEnvFile(envFile: string): Promise<{ label: string; text: string } | { check: Check }> {
  if (envFile === '-') {
    if (process.stdin.isTTY)
      return {
        check: {
          id: 'env-file',
          status: 'fail',
          message: 'no env file on stdin',
          hint: 'Pipe it in: am doctor --env-file - < .env.',
        },
      };
    const text = await readStdin();
    if (!text.trim())
      return {
        check: {
          id: 'env-file',
          status: 'fail',
          message: 'no env file on stdin',
          hint: 'Pipe it in: am doctor --env-file - < .env.',
        },
      };
    return { label: '<stdin>', text };
  }

  const path = resolve(process.env.INIT_CWD ?? process.cwd(), envFile);
  try {
    return { label: path, text: await readFile(path, 'utf8') };
  } catch (err) {
    return { check: await unreadableCheck(path, err) };
  }
}

export async function run(args: string[]): Promise<number> {
  let values: { json?: boolean; help?: boolean; 'env-file'?: string; from?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        'env-file': { type: 'string' },
        from: { type: 'string' },
      },
    }));
  } catch (err) {
    console.error(`am doctor: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  // The file may describe a different .env than the container's environment (the upgrade flow
  // pipes it in), so its values win when present.
  const env: NodeJS.ProcessEnv = { ...process.env };
  let fileText: string | undefined;
  let readCheck: Check | undefined;
  const envFile = values['env-file']?.trim();
  if (envFile) {
    const input = await readEnvFile(envFile);
    if ('check' in input) readCheck = input.check;
    else {
      fileText = input.text;
      for (const [key, value] of Object.entries(envFileValues(fileText))) if (value !== '') env[key] = value;
    }
  }

  const checks = offlineChecks(env);
  if (readCheck) checks.push(readCheck);
  if (fileText) {
    try {
      const example = await readFile(fileURLToPath(TEMPLATE), 'utf8');
      checks.push(...envFileChecks(fileText, example, values.from?.trim()));
    } catch (err) {
      checks.push({
        id: 'env-file',
        status: 'fail',
        message: `cannot read the .env.example template: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'The image or checkout is incomplete; reinstall it.',
      });
    }
  }

  const config = checkConfig(env);
  checks.push(config.check);
  if (config.config) checks.push(...(await liveChecks(config.config)));

  if (values.json) console.log(JSON.stringify(checks, null, 2));
  else printTable(checks);

  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
