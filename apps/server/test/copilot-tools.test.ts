import { describe, expect, it } from 'vitest';
import {
  type CopilotTool,
  copilotTools,
  DISCOVERY_MAX_MATCHES,
  discoverTool,
  discoverTools,
  discoveryReply,
  dropOldestTurn,
  initialTools,
  MAX_ACTIVE_TOOLS,
  MAX_SINGLE_TOOL_TOKENS,
  modelToolName,
  selectDiscovered,
  trimHistory,
} from '../src/http/copilot-tools';

// The copilot's bounded tool exposure (#356): a turn sends only its active tool schemas, starts
// with a small core workflow, and can discover more commands within fixed tool/schema limits.

const tool = (command: string, tokens = 100, description = `${command} does something`): CopilotTool => ({
  command,
  name: modelToolName(command),
  description,
  inputSchema: { type: 'object' },
  tokens,
});

describe('copilotTools', () => {
  it('uses callable model names and counts each definition', () => {
    const [artifacts] = copilotTools([
      {
        name: 'artifacts.list',
        description: 'List artifacts',
        inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
      },
    ]);
    expect(artifacts.name).toBe('artifacts__list');
    expect(artifacts.tokens).toBeGreaterThan(10);
  });

  it('includes the input schema in the estimate', () => {
    const small = copilotTools([{ name: 'x.list', description: 'x', inputSchema: { type: 'object' } }])[0];
    const large = copilotTools([
      {
        name: 'x.list',
        description: 'x',
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}`, { type: 'string' }])),
        },
      },
    ])[0];
    expect(large.tokens).toBeGreaterThan(small.tokens * 5);
  });
});

describe('initialTools', () => {
  it('advertises the core workflow, in order, only for commands the principal has', () => {
    const catalog = [tool('artifacts.requestPublish'), tool('artifacts.list'), tool('artifacts.create'), tool('segments.preview')];
    expect(initialTools(catalog).map((t) => t.command)).toEqual(['artifacts.list', 'artifacts.create', 'artifacts.requestPublish']);
  });

  it('does not put every permitted command in the first request', () => {
    const catalog = Array.from({ length: 136 }, (_, i) => tool(`group${i}.read`));
    expect(initialTools(catalog)).toEqual([]);
  });
});

describe('discoverTools', () => {
  it('ranks an exact command and does not drag in commands sharing a generic word', () => {
    const catalog = [tool('audit.list'), tool('agents.list'), tool('aiProviders.list'), tool('audit.verify')];
    const { matches, total } = discoverTools(catalog, 'audit list');
    expect(matches.map((t) => t.command)).toEqual(['audit.list']);
    expect(total).toBe(1);
  });

  it('bounds what one discovery call returns and reports how many matched', () => {
    const catalog = Array.from({ length: 40 }, (_, i) => tool(`project.item${i}.list`));
    const { matches, total } = discoverTools(catalog, 'project item', 99);
    expect(matches).toHaveLength(DISCOVERY_MAX_MATCHES);
    expect(total).toBe(40);
    const reply = discoveryReply(matches, total, { enabled: [], skipped: [] }, () => false);
    expect(reply.more).toBe(40 - DISCOVERY_MAX_MATCHES);
    expect(reply.note).toContain('more matched');
  });

  it('shortens long descriptions so the reply stays cheap', () => {
    const catalog = [tool('notes.read', 100, 'x'.repeat(400))];
    const { matches, total } = discoverTools(catalog, 'notes read');
    const reply = discoveryReply(matches, total, { enabled: [], skipped: [] }, () => false);
    expect(reply.tools[0].description.length).toBeLessThanOrEqual(160);
  });
});

describe('trimHistory', () => {
  // A stored turn is a user message followed by the assistant/tool messages it produced. A tool
  // result is only valid directly after the assistant call it answers.
  const turn = (n: number) => [
    { role: 'user', content: `question ${n}` },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${n}`, toolName: 'artifacts__list', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${n}`, toolName: 'artifacts__list', output: {} }] },
    { role: 'assistant', content: `answer ${n}` },
  ];

  it('drops a whole turn, so the remainder never starts with a tool result', () => {
    const trimmed = dropOldestTurn([...turn(1), ...turn(2)]);
    expect(trimmed).toEqual(turn(2));
    expect(trimmed[0].role).toBe('user');
  });

  it('trims several complete turns until a multi-turn history fits its allowance', () => {
    const history = [...turn(1), ...turn(2), ...turn(3)];
    // The same character-based estimate the copilot uses, with an allowance one token short of
    // the last two turns. Trimming stops at a user boundary: the first message is still a user
    // message, and every tool result still follows its assistant call.
    const estimate = (h: { role: string }[]) => Math.ceil(JSON.stringify(h).length / 4);
    const allowance = estimate([...turn(2), ...turn(3)]) - 1;
    const trimmed = trimHistory(history, (h) => estimate(h) <= allowance);
    expect(trimmed).toEqual(turn(3));
    expect(trimmed[0].role).toBe('user');
    for (let i = 1; i < trimmed.length; i++) if (trimmed[i].role === 'tool') expect(trimmed[i - 1].role).toBe('assistant');
  });

  it('drops a leading fragment instead of leaving a lone tool result', () => {
    const trimmed = dropOldestTurn([{ role: 'tool', content: 'orphan' }, ...turn(1), ...turn(2)]);
    expect(trimmed).toEqual(turn(2));
  });

  it('returns an empty history when no complete later turn remains', () => {
    expect(dropOldestTurn(turn(1))).toEqual([]);
    expect(trimHistory(turn(1), () => false)).toEqual([]);
  });
});

describe('selectDiscovered', () => {
  it('enables matches while it stays under the tool and schema limits', () => {
    const matches = [tool('a.read', 100), tool('b.read', 200), tool('c.read', 300)];
    const selection = selectDiscovered(
      matches,
      { names: new Set(['artifacts__list']), tokens: 500 },
      {
        maxTools: 3,
        maxSchemaTokens: 900,
        maxSingleToolTokens: 1_000,
      },
    );
    expect(selection.enabled.map((t) => t.command)).toEqual(['a.read', 'b.read']);
    expect(selection.skipped).toEqual([{ command: 'c.read', name: 'c__read', reason: 'tool_limit' }]);
  });

  it('never enables a command whose schema alone is too large for the turn', () => {
    const huge = tool('reports.query', MAX_SINGLE_TOOL_TOKENS + 1);
    const selection = selectDiscovered([huge], { names: new Set([discoverTool.name]), tokens: 200 });
    expect(selection.enabled).toEqual([]);
    expect(selection.skipped).toEqual([{ command: 'reports.query', name: 'reports__query', reason: 'too_large' }]);
    const reply = discoveryReply([huge], 1, selection, () => false);
    expect(reply.note).toContain('needs more tokens than this turn can spend on one tool');
  });

  it('stops enabling before the cumulative schema budget is exhausted', () => {
    const matches = [tool('a.read', 300), tool('b.read', 300)];
    const selection = selectDiscovered(
      matches,
      { names: new Set([discoverTool.name]), tokens: 500 },
      {
        maxTools: MAX_ACTIVE_TOOLS,
        maxSchemaTokens: 900,
        maxSingleToolTokens: 1_000,
      },
    );
    expect(selection.enabled.map((t) => t.command)).toEqual(['a.read']);
    expect(selection.skipped).toEqual([{ command: 'b.read', name: 'b__read', reason: 'schema_budget' }]);
  });
});
