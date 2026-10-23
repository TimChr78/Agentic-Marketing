import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { readPasswordFromStdin, resolvePassword } from '../src/cli-password';

const base = { command: 'bootstrap', envVar: 'AM_BOOTSTRAP_PASSWORD' };

describe('CLI password resolution', () => {
  it('prefers a non-empty environment variable over --password without warning', async () => {
    const warn = vi.fn();
    await expect(resolvePassword({ ...base, env: { AM_BOOTSTRAP_PASSWORD: 'from-env' }, passwordFlag: 'from-flag', warn })).resolves.toBe(
      'from-env',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls through an empty environment variable', async () => {
    const warn = vi.fn();
    await expect(
      resolvePassword({
        ...base,
        env: { AM_BOOTSTRAP_PASSWORD: '' },
        stdinIsTTY: false,
        readStdin: async () => 'from-stdin',
        warn,
      }),
    ).resolves.toBe('from-stdin');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts --password for backwards compatibility but warns', async () => {
    const warn = vi.fn();
    await expect(resolvePassword({ ...base, env: {}, passwordFlag: 'from-flag', warn })).resolves.toBe('from-flag');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('deprecated');
    expect(warn.mock.calls[0]?.[0]).toContain('AM_BOOTSTRAP_PASSWORD');
  });

  it('rejects an explicitly empty --password instead of falling through', async () => {
    const warn = vi.fn();
    const readStdin = vi.fn(async () => 'from-stdin');
    await expect(resolvePassword({ ...base, env: {}, passwordFlag: '', stdinIsTTY: false, readStdin, warn })).rejects.toThrow(
      '--password was given an empty value',
    );
    expect(readStdin).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('prompts twice on a terminal and accepts a matching password', async () => {
    const promptHidden = vi.fn(async (label: string) => (label.startsWith('Password') ? 'hidden-pass' : 'hidden-pass'));
    await expect(resolvePassword({ ...base, env: {}, stdinIsTTY: true, promptHidden })).resolves.toBe('hidden-pass');
    expect(promptHidden.mock.calls.map(([label]) => label)).toEqual(['Password: ', 'Confirm password: ']);
  });

  it('rejects when the confirmation does not match', async () => {
    const promptHidden = vi.fn(async (label: string) => (label.startsWith('Password') ? 'one-pass' : 'other-pass'));
    await expect(resolvePassword({ ...base, env: {}, stdinIsTTY: true, promptHidden })).rejects.toThrow('do not match');
  });

  it('rejects an empty prompt', async () => {
    const promptHidden = vi.fn(async () => '');
    await expect(resolvePassword({ ...base, env: {}, stdinIsTTY: true, promptHidden })).rejects.toThrow('cannot be empty');
  });

  it('reads from stdin when it is not a terminal', async () => {
    await expect(resolvePassword({ ...base, env: {}, stdinIsTTY: false, readStdin: async () => 'from-stdin' })).resolves.toBe('from-stdin');
  });

  it('trims only the trailing newline from stdin and keeps spaces', async () => {
    await expect(
      resolvePassword({
        ...base,
        env: {},
        stdinIsTTY: false,
        readStdin: () => readPasswordFromStdin(Readable.from(['  pass with spaces \r\nsecond line\n'])),
      }),
    ).resolves.toBe('  pass with spaces ');
  });

  it('rejects when stdin is empty', async () => {
    const readStdin = vi.fn(async () => '');
    await expect(resolvePassword({ ...base, env: {}, stdinIsTTY: false, readStdin })).rejects.toThrow('no password provided');
  });

  it('uses the reset-password environment variable for reset-password', async () => {
    await expect(
      resolvePassword({ command: 'reset-password', envVar: 'AM_RESET_PASSWORD', env: { AM_RESET_PASSWORD: 'new-pass' } }),
    ).resolves.toBe('new-pass');
  });
});
