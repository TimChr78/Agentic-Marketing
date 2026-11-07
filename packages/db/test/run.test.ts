import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTIFIER_BYTES,
  MAX_RUN_ID_LENGTH,
  runScopedFor,
  sanitiseRunId,
  scopedDbName,
  testPortOffset,
} from './run';

// A run id is a namespace, not a free-form label: every name built from it becomes an unquoted
// PostgreSQL identifier, so it must be short and safe. These checks are the contract the shell
// helper (`print-db`) and the harness both rely on.

const SHA = 'a3f5c9e1b7d24680f1e2d3c4b5a69788abcdef01'; // 40 characters, as a checkout or CI run may pass

describe('run identifiers', () => {
  it('keeps short ids and strips anything that is not a lower-case letter or digit', () => {
    expect(sanitiseRunId('Run-A_01!')).toBe('runa01');
    expect(sanitiseRunId('r'.repeat(MAX_RUN_ID_LENGTH))).toBe('r'.repeat(MAX_RUN_ID_LENGTH));
  });

  it('hashes a 40-character id to a stable, bounded 10-hex run id', () => {
    const id = sanitiseRunId(SHA);
    expect(id).toMatch(/^[0-9a-f]{10}$/);
    expect(sanitiseRunId(SHA)).toBe(id);
    expect(sanitiseRunId(`b${SHA.slice(1)}`)).not.toBe(id);
  });

  it('scopes exactly as the harness creates databases', () => {
    expect(scopedDbName('am_test_p1', 'run1')).toBe('am_run1_test_p1');
    expect(scopedDbName('test_p1', 'run1')).toBe('am_run1_test_p1');
    expect(scopedDbName('am_e2e_20260101', 'run1')).toBe('am_run1_e2e_20260101');
    expect(scopedDbName('am_test_p1', '')).toBe('am_test_p1');
  });

  it('keeps every scoped name within PostgreSQL’s 63-byte identifier limit', () => {
    const id = sanitiseRunId(SHA);
    for (const name of [
      'am_test_template',
      'am_test_hosted_lifecycle',
      'am_test_events',
      'am_backup_ch_0123456789',
      'am_backup_erasure_0123456789',
      'am_doctor_12345_0123abcd',
      'am_e2e_20260101_120000_12345',
    ]) {
      expect(Buffer.byteLength(scopedDbName(name, id), 'utf8')).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    }
  });

  it('refuses a final identifier over 63 bytes with a clear error', () => {
    expect(() => runScopedFor('run1', `am_${'x'.repeat(64)}`)).toThrow(/63-byte identifier limit/);
    expect(() => runScopedFor('run1', `am_${'x'.repeat(54)}`)).not.toThrow();
  });

  it('prints the exact database name a shell wrapper must verify or drop', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./run.ts', import.meta.url)), 'print-db', 'am_e2e_20260101_120000_123'],
      {
        encoding: 'utf8',
        env: { ...process.env, AM_TEST_RUN: 'Run-A', CI: '' },
      },
    );
    expect(output.trim()).toBe('am_runa_e2e_20260101_120000_123');
  });

  it('derives the same name the harness would for an explicit run', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./run.ts', import.meta.url)), 'print-db', 'am_test_template'],
      { encoding: 'utf8', env: { ...process.env, AM_TEST_RUN: SHA, CI: '' } },
    );
    expect(output.trim()).toBe(`am_${sanitiseRunId(SHA)}_test_template`);
  });
});

describe('port offset', () => {
  it('is 0 when unset and reads TEST_PORT_OFFSET when set', () => {
    expect(testPortOffset({})).toBe(0);
    expect(testPortOffset({ TEST_PORT_OFFSET: '' })).toBe(0);
    expect(testPortOffset({ TEST_PORT_OFFSET: 'not-a-number' })).toBe(0);
    expect(testPortOffset({ TEST_PORT_OFFSET: '10000' })).toBe(10000);
  });
});
