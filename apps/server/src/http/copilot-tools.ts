import { estimateTokens } from '@agentic-marketing/ai';

// The copilot is an MCP client like any agent, but its model call is paid from a bounded turn
// allowance (#356). Sending every permitted command's input schema can cost more than that
// allowance before the model is asked anything, so the turn starts with a small core toolset and
// a discovery tool that enables a few more commands for the next step. Only the active tools are
// sent to the model (AI SDK `activeTools`), so the estimate may count only those schemas.

/** A command as the copilot can call it: the MCP tool, and the name the model sees. */
export interface CopilotTool {
  /** The MCP tool/command name, e.g. `artifacts.list`. */
  command: string;
  /** The callable name the model sees, e.g. `artifacts__list` (some APIs reject dots). */
  name: string;
  description: string;
  inputSchema: unknown;
  /** Estimated prompt tokens of the definition as the model receives it. */
  tokens: number;
}

/** MCP tool names may contain dots; model APIs allow letters, digits, _ and - only. */
export const modelToolName = (name: string) => name.replaceAll('.', '__');

const tokensOf = (name: string, description: string, inputSchema: unknown) =>
  Math.ceil(estimateTokens({ name, description, inputSchema }, 0));

/**
 * What a copilot turn advertises before the model has asked for anything: the artifact workflow
 * (look, create, edit, request publishing) and discovery. Other commands are one discovery away.
 */
export const INITIAL_COMMANDS = [
  'artifacts.list',
  'artifacts.types',
  'artifacts.get',
  'artifacts.create',
  'artifacts.updateDraft',
  'artifacts.requestPublish',
] as const;

export const DISCOVER_COMMAND = 'tools.discover';
export const DISCOVER_NAME = modelToolName(DISCOVER_COMMAND);

/** The discovery tool's own definition, kept out of the MCP catalog because it is local. */
export const DISCOVER_DESCRIPTION =
  'Find and enable more of this person’s commands for this turn. Only a small core toolset is sent at first so the turn fits its AI budget. Call with a command name (e.g. "segments.preview") or what you want to do; it returns and enables a few matching tools for the next step. It never returns commands this person may not run.';

export const DISCOVER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      maxLength: 200,
      description: 'A command name or what you want to do, e.g. "journey simulate" or "artifacts.requestPublish".',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 6,
      default: 6,
      description: 'The most tools to return (and enable).',
    },
  },
  additionalProperties: false,
} as const;

export const discoverTool: CopilotTool = {
  command: DISCOVER_COMMAND,
  name: DISCOVER_NAME,
  description: DISCOVER_DESCRIPTION,
  inputSchema: DISCOVER_INPUT_SCHEMA,
  tokens: tokensOf(DISCOVER_NAME, DISCOVER_DESCRIPTION, DISCOVER_INPUT_SCHEMA),
};

/** The most matches one discovery call returns; its output is bounded too. */
export const DISCOVERY_MAX_MATCHES = 6;
/** The most tools a single turn may have active after discovery (including discovery itself). */
export const MAX_ACTIVE_TOOLS = 12;
/** The most estimated schema tokens a turn may have active after discovery. */
export const MAX_ACTIVE_SCHEMA_TOKENS = 8_000;
/** A single command whose definition is larger than this is not worth enabling in a 20k turn. */
export const MAX_SINGLE_TOOL_TOKENS = 4_000;

/** Turns the MCP catalog into callable definitions with their estimated prompt cost. */
export function copilotTools(tools: { name: string; title?: string; description?: string; inputSchema?: unknown }[]): CopilotTool[] {
  return tools
    .filter((t) => t.name !== DISCOVER_COMMAND)
    .map((t) => {
      const name = modelToolName(t.name);
      const description = t.description ?? t.title ?? t.name;
      const inputSchema = t.inputSchema ?? {};
      return { command: t.name, name, description, inputSchema, tokens: tokensOf(name, description, inputSchema) };
    });
}

/** The initial toolset, in preference order, limited to commands this principal actually has. */
export function initialTools(catalog: CopilotTool[]): CopilotTool[] {
  const byCommand = new Map(catalog.map((t) => [t.command, t]));
  return INITIAL_COMMANDS.map((name) => byCommand.get(name)).filter((t): t is CopilotTool => t !== undefined);
}

/**
 * Drops the oldest complete turn: its user message and every assistant/tool message that belongs
 * to it. Trimming message by message can leave a tool result without the assistant call it answers,
 * which providers reject, so only user-message boundaries are safe.
 */
export function dropOldestTurn<M extends { role: string }>(history: M[]): M[] {
  const firstUser = history.findIndex((m) => m.role === 'user');
  if (firstUser === -1) return [];
  const nextUser = history.findIndex((m, i) => i > firstUser && m.role === 'user');
  return nextUser === -1 ? [] : history.slice(nextUser);
}

/** Removes whole turns until the remaining history fits, so the first message is always a user turn. */
export function trimHistory<M extends { role: string }>(history: M[], fits: (history: M[]) => boolean): M[] {
  let trimmed = history;
  while (trimmed.length && !fits(trimmed)) trimmed = dropOldestTurn(trimmed);
  return trimmed;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/** `artifacts.list` reads like `artifacts list`, so a spoken query can match the full name. */
const normalized = (s: string) => s.toLowerCase().replaceAll('.', ' ').replaceAll('_', ' ').replace(/\s+/g, ' ').trim();

function score(t: CopilotTool, query: string): number {
  if (!query) return 0;
  const command = normalized(t.command);
  let n = 0;
  if (command === query) n += 200;
  else if (command.includes(query)) n += 60;
  const description = t.description.toLowerCase();
  for (const word of words(query)) {
    if (command.includes(word)) n += 5;
    else if (description.includes(word)) n += 2;
  }
  return n;
}

/** Rank matching commands and return at most `limit` of them (the caller's output stays small). */
export function discoverTools(
  catalog: CopilotTool[],
  query = '',
  limit = DISCOVERY_MAX_MATCHES,
): { matches: CopilotTool[]; total: number } {
  const q = normalized(query);
  const scored = catalog
    .map((t) => ({ t, score: score(t, q) }))
    .filter((x) => !q || x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.command.localeCompare(b.t.command));
  // A strong match (an exact command, say) should not drag in every command that happens to
  // share a generic word such as "list".
  const floor = q ? Math.max(1, Math.ceil((scored[0]?.score ?? 0) / 4)) : 0;
  const ranked = scored.filter((x) => x.score >= floor).map((x) => x.t);
  const bounded = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : DISCOVERY_MAX_MATCHES, DISCOVERY_MAX_MATCHES));
  return { matches: ranked.slice(0, bounded), total: ranked.length };
}

export interface ActiveTools {
  names: ReadonlySet<string>;
  /** Estimated prompt tokens of all currently active definitions. */
  tokens: number;
}

export type SkipReason = 'too_large' | 'tool_limit' | 'schema_budget';

export interface DiscoverySelection {
  enabled: CopilotTool[];
  skipped: { command: string; name: string; reason: SkipReason }[];
}

/**
 * Enables as many matches as the turn's active budget allows. Cumulative limits keep discovery
 * from turning the next step into the same oversized catalog, and a command whose definition is
 * too large for what is left of the allowance is reported instead of being enabled.
 */
export function selectDiscovered(
  matches: CopilotTool[],
  active: ActiveTools,
  limits: { maxTools?: number; maxSchemaTokens?: number; maxSingleToolTokens?: number } = {},
): DiscoverySelection {
  const maxTools = limits.maxTools ?? MAX_ACTIVE_TOOLS;
  const maxSchemaTokens = limits.maxSchemaTokens ?? MAX_ACTIVE_SCHEMA_TOKENS;
  const maxSingleToolTokens = limits.maxSingleToolTokens ?? MAX_SINGLE_TOOL_TOKENS;
  const enabled: CopilotTool[] = [];
  const skipped: DiscoverySelection['skipped'] = [];
  let count = active.names.size;
  let tokens = active.tokens;
  for (const t of matches) {
    if (active.names.has(t.name)) continue;
    if (t.tokens > maxSingleToolTokens) {
      skipped.push({ command: t.command, name: t.name, reason: 'too_large' });
      continue;
    }
    if (count >= maxTools) {
      skipped.push({ command: t.command, name: t.name, reason: 'tool_limit' });
      continue;
    }
    if (tokens + t.tokens > maxSchemaTokens) {
      skipped.push({ command: t.command, name: t.name, reason: 'schema_budget' });
      continue;
    }
    enabled.push(t);
    count++;
    tokens += t.tokens;
  }
  return { enabled, skipped };
}

const brief = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface DiscoveryReply {
  tools: { name: string; command: string; description: string; active: boolean }[];
  enabled: string[];
  skipped: DiscoverySelection['skipped'];
  total: number;
  more: number;
  note: string;
}

/** The bounded answer of `tools.discover`; descriptions are shortened so the reply stays cheap. */
export function discoveryReply(
  matches: CopilotTool[],
  total: number,
  selection: DiscoverySelection,
  isActive: (name: string) => boolean,
): DiscoveryReply {
  const more = Math.max(0, total - matches.length);
  const notes: string[] = [];
  if (selection.enabled.length) notes.push(`Enabled for the next step: ${selection.enabled.map((t) => t.name).join(', ')}.`);
  if (selection.skipped.length)
    notes.push(
      `Not enabled: ${selection.skipped
        .map((s) =>
          s.reason === 'too_large'
            ? `${s.name} (its schema needs more tokens than this turn can spend on one tool)`
            : s.reason === 'tool_limit'
              ? `${s.name} (too many tools in one turn)`
              : `${s.name} (this turn's tool budget is full)`,
        )
        .join(', ')}.`,
    );
  if (more) notes.push(`${more} more matched; add words to the query to narrow it.`);
  if (!matches.length) notes.push('No command matched; try a command name such as artifacts.list.');
  return {
    tools: matches.map((t) => ({
      name: t.name,
      command: t.command,
      description: brief(t.description),
      active: isActive(t.name),
    })),
    enabled: selection.enabled.map((t) => t.name),
    skipped: selection.skipped,
    total,
    more,
    note: notes.join(' '),
  };
}
