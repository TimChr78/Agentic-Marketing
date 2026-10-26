import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../src/config';
import { envFileKeys } from '../src/ops/checks';
import { compareVersions, ENV_SINCE, envKeysSince } from '../src/ops/env-history';

// A new variable without a "since" would make `am doctor --env-file` guess, so fail the build.
describe('environment variable history', () => {
  it('has a release for every key in .env.example and in the Env schema', async () => {
    const example = await readFile(new URL('../../../.env.example', import.meta.url), 'utf8');
    const documented = new Set(envFileKeys(example, true));
    for (const key of [...documented, ...ENV_KEYS]) expect(ENV_SINCE[key], `${key} needs an entry in ops/env-history.ts`).toBeTruthy();
  });

  it('knows what each release added', () => {
    expect(envKeysSince('0.2.4')).toEqual([]);
    expect(envKeysSince('0.2.3')).toEqual(['BACKUP_CRON', 'BACKUP_DIR', 'BACKUP_KEEP_DAYS', 'PUBLIC_BIND', 'SKIP_PRE_UPGRADE_BACKUP']);
    expect(envKeysSince('0.1.2')).toEqual(
      expect.arrayContaining(['ASSET_MAX_BYTES', 'MCP_TEXT_CONTENT', 'MCP_TOOL_NAME_STYLE', 'STRICT_INPUTS']),
    );
    expect(envKeysSince('0.2.4')).not.toContain('BACKUP_DIR');
  });

  it('compares release versions and rejects non-versions', () => {
    expect(compareVersions('0.2.4', '0.2.3')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.4', '0.2.4')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('dev', '0.2.4')).toBeNull();
    expect(envKeysSince('dev')).toBeNull();
  });
});
