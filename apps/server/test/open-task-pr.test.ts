import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// scripts/open-task-pr.sh pushes a branch and opens a draft PR, so its guards run before any git or
// gh call: only a feat/phase-<n> base, never main/master/a phase or release branch as the task.

const script = fileURLToPath(new URL('../../../scripts/open-task-pr.sh', import.meta.url));
const run = (...args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

describe('open-task-pr.sh guards', () => {
  it.each([
    [['task/x', 'main', '1', 'T'], /not a phase branch/],
    [['task/x', 'release-0.12.0', '1', 'T'], /not a phase branch/],
    [['task/x', 'feat/phase-27oops', '1', 'T'], /not a phase branch/],
    [['feat/phase-27', 'feat/phase-27', '1', 'T'], /cannot be a task branch/],
    [['main', 'feat/phase-27', '1', 'T'], /cannot be a task branch/],
    [['feat/phase-26', 'feat/phase-27', '1', 'T'], /cannot be a task branch/],
    [['task/x', 'feat/phase-27', 'abc', 'T'], /issue must be a number/],
    [['task/x', 'feat/phase-27', '1'], /usage/],
  ])('refuses %j', (args, message) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
  });
});
