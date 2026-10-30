import Anthropic from '@anthropic-ai/sdk';
import { commandName, commands, toolName } from '../api/commands';
import type { LiveConfig, Sink } from './types';

// Live mode: a real model drives the same command registry the MCP server exposes.
// Keys stay in memory for this tab only.

const SYSTEM = `You are the copilot inside an open-source marketing platform, acting for the workspace "Fjeldvej Outdoor" (a Danish outdoor retailer, currency DKK, EU/GDPR).
You operate the platform only through the provided tools, which are the same tools external MCP clients get.
Rules:
- Every change you make is a draft. To publish, call journeys__requestPublish; the workspace policy decides whether a human must approve. Never claim that something was sent or published unless a tool result says so.
- Respect privacy: do not ask for or repeat e-mail addresses unless needed; explain consent and lawful basis when relevant.
- Before creating a journey, size the audience with segments__estimate, and simulate the draft with journeys__simulate before requesting publish.
- Keep replies short and concrete, in plain language for a marketer.`;

const agentTools = commands.filter((c) => !c.humansOnly);

async function runAnthropic(cfg: LiveConfig, prompt: string, sink: Sink, history: Anthropic.Beta.BetaMessageParam[]) {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined, dangerouslyAllowBrowser: true });
  const firstParty = !cfg.baseUrl || cfg.baseUrl.includes('api.anthropic.com');
  const tools: Anthropic.Beta.BetaTool[] = agentTools.map((c) => ({
    name: toolName(c.name),
    description: c.description,
    input_schema: c.input as Anthropic.Beta.BetaTool['input_schema'],
  }));
  history.push({ role: 'user', content: prompt });
  for (let turn = 0; turn < 12; turn++) {
    const res = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages: history,
      // Server-side fallback on refusals is only available on the first-party API.
      ...(firstParty ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (res.stop_reason === 'refusal') {
      sink.say('The model declined this request. Try rephrasing it.');
      return;
    }
    history.push({ role: 'assistant', content: res.content });
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) sink.say(text);
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) return;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      try {
        const out = await sink.tool(commandName(call.name), call.input);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: (err as Error).message, is_error: true });
      }
    }
    history.push({ role: 'user', content: results });
  }
  sink.say('I stopped after 12 steps. Ask me to continue if needed.');
}

type OaMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

async function runOpenAI(cfg: LiveConfig, prompt: string, sink: Sink, history: OaMessage[]) {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  if (!history.length) history.push({ role: 'system', content: SYSTEM });
  history.push({ role: 'user', content: prompt });
  const tools = agentTools.map((c) => ({
    type: 'function',
    function: { name: toolName(c.name), description: c.description, parameters: c.input },
  }));
  for (let turn = 0; turn < 12; turn++) {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: history, tools }),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const msg = (await r.json()).choices[0].message as OaMessage;
    history.push(msg);
    if (msg.content) sink.say(msg.content);
    if (!msg.tool_calls?.length) return;
    for (const call of msg.tool_calls) {
      let content: string;
      try {
        content = JSON.stringify(await sink.tool(commandName(call.function.name), JSON.parse(call.function.arguments || '{}')));
      } catch (err) {
        content = `Error: ${(err as Error).message}`;
      }
      history.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
}

export function createLiveSession(cfg: LiveConfig) {
  const anthropicHistory: Anthropic.Beta.BetaMessageParam[] = [];
  const openaiHistory: OaMessage[] = [];
  return (prompt: string, sink: Sink) =>
    cfg.provider === 'anthropic' ? runAnthropic(cfg, prompt, sink, anthropicHistory) : runOpenAI(cfg, prompt, sink, openaiHistory);
}
