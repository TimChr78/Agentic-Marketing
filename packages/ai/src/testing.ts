import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A scripted LLM server for tests: speaks the OpenAI chat-completions and Anthropic messages
// wire formats, plain and streamed (server-sent events, text in several chunks), so tests
// exercise the real provider adapters. The base URL for either kind is `${url}/v1`.

export interface FakeRequest {
  api: 'openai' | 'anthropic';
  model: string;
  apiKey: string;
  system: string;
  /** Every message flattened to text (tool calls and results as JSON). */
  messages: { role: string; text: string }[];
  /** The text of the last user message. */
  user: string;
  tools: string[];
  /** Results of tool calls in this conversation, oldest first. */
  toolResults: string[];
  /** Whether a JSON answer was requested (structured output). */
  json: boolean;
  /** The output cap the caller sent, if any (openai `max_completion_tokens`, anthropic `max_tokens`). */
  maxOutputTokens?: number;
}

export type FakeReply =
  | { text: string; inputTokens?: number; outputTokens?: number }
  | { toolCalls: { name: string; input: unknown }[] }
  | { status: number; error: string };

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((p: Record<string, unknown>) =>
            p.type === 'text' ? String(p.text) : p.type === 'tool_result' ? textOf(p.content) : JSON.stringify(p),
          )
          .join('\n')
      : JSON.stringify(c ?? '');

interface WireRequest {
  model: string;
  system?: unknown;
  messages?: { role: string; content: unknown; tool_calls?: unknown }[];
  tools?: { name?: string; function?: { name: string } }[];
  response_format?: unknown;
  output_config?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

function normalise(api: FakeRequest['api'], body: WireRequest, apiKey: string): FakeRequest {
  const msgs = body.messages ?? [];
  const system =
    api === 'openai'
      ? msgs
          .filter((m) => m.role === 'system')
          .map((m) => textOf(m.content))
          .join('\n')
      : textOf(body.system ?? '');
  const messages = msgs
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, text: m.tool_calls ? JSON.stringify(m.tool_calls) : textOf(m.content) }));
  const toolResults =
    api === 'openai'
      ? msgs.filter((m) => m.role === 'tool').map((m) => textOf(m.content))
      : msgs.flatMap((m) =>
          Array.isArray(m.content)
            ? (m.content as Record<string, unknown>[]).filter((p) => p.type === 'tool_result').map((p) => textOf(p.content))
            : [],
        );
  const users = messages.filter((m) => m.role === 'user');
  return {
    api,
    model: body.model,
    apiKey,
    system,
    messages,
    user: users[users.length - 1]?.text ?? '',
    tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? ''),
    toolResults,
    json: !!(body.response_format || body.output_config),
    maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
  };
}

let seq = 0;

function encode(api: FakeRequest['api'], model: string, reply: FakeReply) {
  const id = `fake_${++seq}`;
  if ('status' in reply)
    return {
      status: reply.status,
      body:
        api === 'openai'
          ? { error: { message: reply.error, type: 'error' } }
          : { type: 'error', error: { type: 'api_error', message: reply.error } },
    };
  const usage = 'text' in reply ? { input: reply.inputTokens ?? 100, output: reply.outputTokens ?? 20 } : { input: 100, output: 20 };
  if (api === 'openai')
    return {
      status: 200,
      body: {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message:
              'text' in reply
                ? { role: 'assistant', content: reply.text }
                : {
                    role: 'assistant',
                    content: null,
                    tool_calls: reply.toolCalls.map((t, i) => ({
                      id: `${id}_${i}`,
                      type: 'function',
                      function: { name: t.name, arguments: JSON.stringify(t.input) },
                    })),
                  },
            finish_reason: 'text' in reply ? 'stop' : 'tool_calls',
          },
        ],
        usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
      },
    };
  return {
    status: 200,
    body: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content:
        'text' in reply
          ? [{ type: 'text', text: reply.text }]
          : reply.toolCalls.map((t, i) => ({ type: 'tool_use', id: `${id}_${i}`, name: t.name, input: t.input })),
      stop_reason: 'text' in reply ? 'end_turn' : 'tool_use',
      usage: { input_tokens: usage.input, output_tokens: usage.output },
    },
  };
}

/** Splits text into a few pieces, as a model streams it. */
const pieces = (text: string) => {
  const size = Math.max(1, Math.ceil(text.length / 3));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

/** The same reply as server-sent events, in the provider's streaming format. */
function encodeStream(api: FakeRequest['api'], model: string, reply: Exclude<FakeReply, { status: number }>): string {
  const id = `fake_${++seq}`;
  const usage = 'text' in reply ? { input: reply.inputTokens ?? 100, output: reply.outputTokens ?? 20 } : { input: 100, output: 20 };
  if (api === 'openai') {
    const chunk = (delta: unknown, finish: string | null = null, extra: object = {}) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const body =
      'text' in reply
        ? [chunk({ role: 'assistant', content: '' }), ...pieces(reply.text).map((t) => chunk({ content: t })), chunk({}, 'stop')]
        : [
            chunk({ role: 'assistant', content: null }),
            ...reply.toolCalls.map((t, i) =>
              chunk({
                tool_calls: [
                  { index: i, id: `${id}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } },
                ],
              }),
            ),
            chunk({}, 'tool_calls'),
          ];
    const usageChunk = `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } })}\n\n`;
    return `${body.join('')}${usageChunk}data: [DONE]\n\n`;
  }
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const blocks =
    'text' in reply
      ? [
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ...pieces(reply.text).map((t) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })),
          ev('content_block_stop', { index: 0 }),
        ]
      : reply.toolCalls.flatMap((t, i) => [
          ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: `${id}_${i}`, name: t.name, input: {} } }),
          ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } }),
          ev('content_block_stop', { index: i }),
        ]);
  return [
    ev('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: usage.input, output_tokens: 1 },
      },
    }),
    ...blocks,
    ev('message_delta', {
      delta: { stop_reason: 'text' in reply ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: usage.output },
    }),
    ev('message_stop', {}),
  ].join('');
}

export async function fakeLlm(handler: (r: FakeRequest) => FakeReply | Promise<FakeReply>) {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const api = req.url?.endsWith('/chat/completions') ? 'openai' : req.url?.endsWith('/messages') ? 'anthropic' : null;
      res.setHeader('content-type', 'application/json');
      if (!api) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      const apiKey = String(req.headers.authorization ?? '').replace(/^Bearer /, '') || String(req.headers['x-api-key'] ?? '');
      const body = JSON.parse(raw) as WireRequest;
      const r = normalise(api, body, apiKey);
      requests.push(r);
      try {
        const reply = await handler(r);
        if (body.stream && !('status' in reply)) {
          res.setHeader('content-type', 'text/event-stream');
          res.end(encodeStream(api, r.model, reply));
          return;
        }
        const out = encode(api, r.model, reply);
        res.statusCode = out.status;
        res.end(JSON.stringify(out.body));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: (err as Error).message } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    baseUrl: `${url}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
