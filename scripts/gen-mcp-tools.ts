import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commands } from '../apps/server/src/registry';

// Generates `.claude/skills/agentic-marketing-mcp/references/tools.md` from the command registry.
// Importing the registry only builds command definitions (zod schemas and handlers); it opens no
// database, NATS or ClickHouse connection, so this runs offline. Run it with:
//
//   npx tsx scripts/gen-mcp-tools.ts
//
// The MCP server (apps/server/src/http/mcp.ts) lists a command as a tool only when it has a
// permission and is not humans-only; everything else is marked here so an agent does not look for
// it in tools/list.

const root = fileURLToPath(new URL('..', import.meta.url));
export const TOOLS_DOC_PATH = join(root, '.claude/skills/agentic-marketing-mcp/references/tools.md');

const HEADER = `# Tool catalog

Generated from the command registry (\`apps/server/src/registry.ts\`). **Effect**: \`read\` changes nothing; \`write\` changes drafts or data; \`publish\` reaches customers or needs approval; \`destructive\` cannot be undone. **Who**: "people only" tools are not offered to agents (MCP or API tokens), whatever the scopes. Otherwise the scope in **Permission** is needed.

| Tool | Effect | Permission | Who | What |
|---|---|---|---|---|`;

/** The metadata the catalog needs from a command definition. */
type CommandMeta = {
  name: string;
  description: string;
  effect: string;
  permission: string | null;
  humansOnly?: boolean;
};

/** One table row. Commands without a permission are not registered as MCP tools (see mcp.ts). */
function row(cmd: CommandMeta): string {
  const permission = cmd.permission ?? '–';
  const who = cmd.humansOnly ? 'people only' : 'people and agents';
  const what = cmd.permission ? cmd.description : `${cmd.description} (not an MCP tool)`;
  return `| \`${cmd.name}\` | ${cmd.effect} | ${permission} | ${who} | ${what} |`;
}

/** The whole tools.md document for the given commands, sorted deterministically by name. */
export function renderToolCatalog(defs: readonly CommandMeta[] = commands): string {
  const rows = [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(row);
  return `${[HEADER, ...rows].join('\n')}\n`;
}

/** Command names as they appear in a tools.md table, for the drift check. */
export function documentedToolNames(markdown: string): string[] {
  return [...markdown.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
}

async function main() {
  await writeFile(TOOLS_DOC_PATH, renderToolCatalog());
  console.log(`Wrote ${TOOLS_DOC_PATH} (${commands.length} commands).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
