import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { documentedToolNames, renderToolCatalog, TOOLS_DOC_PATH } from '../../../scripts/gen-mcp-tools';
import { commands } from '../src/registry';

// The MCP skill's tool catalog must match the command registry. Pure metadata: importing the
// registry builds command definitions only, so this needs no Postgres, ClickHouse or NATS.

const REGENERATE = 'Run `npx tsx scripts/gen-mcp-tools.ts` and commit the result.';

describe('MCP tool catalog', () => {
  it('tools.md lists exactly the commands in the registry', async () => {
    const actual = await readFile(TOOLS_DOC_PATH, 'utf8');
    const expected = renderToolCatalog();
    if (actual === expected) return;

    const documented = new Set(documentedToolNames(actual));
    const registered = new Set<string>(commands.map((c) => c.name));
    const missing = [...registered].filter((name) => !documented.has(name)).sort();
    const extra = [...documented].filter((name) => !registered.has(name)).sort();
    const detail = [
      missing.length ? `Missing from tools.md (${missing.length}): ${missing.join(', ')}` : '',
      extra.length ? `In tools.md but not in the registry (${extra.length}): ${extra.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    expect.fail(
      detail
        ? `The MCP tool catalog is out of date.\n${detail}\n${REGENERATE}`
        : `The MCP tool catalog is out of date (rows or header differ).\n${REGENERATE}`,
    );
  });
});
