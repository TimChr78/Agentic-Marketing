import { describe, expect, it } from 'vitest';
import { scanEnvReads } from './env-reads';

// The scanner behind the deployment completeness guard (#965 review A) must see every spelling the
// server uses to read its environment, and must refuse to pass a write or a non-environment object.

const scan = (source: string) => scanEnvReads({ file: 'fixture.ts', source });
const keys = (source: string) => [...new Set(scan(source).reads.map((read) => read.key))].sort();
const dynamic = (source: string) => scan(source).dynamic.map((read) => read.kind);

describe('the environment scan resolves every bound spelling', () => {
  it('reads plain property and literal element accesses', () => {
    expect(keys("process.env.ALPHA; process.env['BETA'];")).toEqual(['ALPHA', 'BETA']);
  });

  it('resolves a constant string key', () => {
    expect(keys("const KEY = 'GAMMA';\nprocess.env[KEY];")).toEqual(['GAMMA']);
    expect(keys('const KEY = `GAMMA`;\nprocess.env[KEY];')).toEqual(['GAMMA']);
  });

  it('treats an ambiguous constant as dynamic', () => {
    const source = [
      "function one() { const KEY = 'ONE'; return process.env[KEY]; }",
      "function two() { const KEY = 'TWO'; return process.env[KEY]; }",
    ].join('\n');
    expect(keys(source)).toEqual([]);
    expect(dynamic(source)).toEqual(['element', 'element']);
  });

  it('reads a destructuring pattern, including a renamed key', () => {
    expect(keys('const { DELTA, EPSILON: renamed } = process.env;')).toEqual(['DELTA', 'EPSILON']);
  });

  it('follows a variable bound to the environment, with ?? and a spread copy', () => {
    expect(keys('const env = process.env;\nenv.ZETA;')).toEqual(['ZETA']);
    expect(keys('const env = options.env ?? process.env;\nenv.ETA;')).toEqual(['ETA']);
    expect(keys('const env = { ...process.env };\nenv.MU;')).toEqual(['MU']);
  });

  it('follows a default parameter and a parameter typed as an environment map', () => {
    expect(keys('function f(env: NodeJS.ProcessEnv = process.env) { return env.THETA; }')).toEqual(['THETA']);
    expect(keys('function f(env: NodeJS.ProcessEnv) { return env.IOTA; }')).toEqual(['IOTA']);
    expect(keys('function f(env: Record<string, string | undefined>) { return env.KAPPA; }')).toEqual(['KAPPA']);
  });

  it('resolves a local alias of an environment map, including a chained alias', () => {
    const source = [
      'export type Base = Record<string, string | undefined>;',
      'export type Env = Base;',
      'export function f(env: Env) { return env.LAMBDA; }',
    ].join('\n');
    expect(keys(source)).toEqual(['LAMBDA']);
  });

  it('follows the variable name a known helper is called with', () => {
    expect(keys("resolvePassword({ envVar: 'NU' });")).toEqual(['NU']);
    expect(keys("const NAME = 'NU';\nresolvePassword({ envVar: NAME });")).toEqual(['NU']);
  });

  it('reads process.env through an element access of the object itself', () => {
    expect(keys("process['env'].PI;")).toEqual(['PI']);
  });

  it('follows a chain of aliases, however long', () => {
    const source = ['const first = process.env;', 'const second = first;', 'const third = second;', 'third.RHO;'].join('\n');
    expect(keys(source)).toEqual(['RHO']);
    expect(dynamic(source)).toEqual([]);
  });

  it('recognises the global spellings of the process environment', () => {
    expect(keys('globalThis.process.env.SIGMA;')).toEqual(['SIGMA']);
    expect(keys('global.process.env.TAU;')).toEqual(['TAU']);
    expect(keys("globalThis.process['env'].UPSILON;")).toEqual(['UPSILON']);
    expect(keys("global['process'].env.PHI;")).toEqual(['PHI']);
    const alias = 'const env = globalThis.process.env;\nenv.CHI;';
    expect(keys(alias)).toEqual(['CHI']);
  });
});

describe('the environment scan refuses what it cannot resolve', () => {
  it('reports a dynamic element access', () => {
    const source = 'const env = process.env;\nenv[readName()];';
    expect(keys(source)).toEqual([]);
    expect(dynamic(source)).toEqual(['element']);
  });

  it('reports an unresolvable destructuring rest', () => {
    const source = 'const { ...rest } = process.env;';
    expect(keys(source)).toEqual([]);
    expect(dynamic(source)).toEqual(['element']);
  });

  it('reports enumerating the whole environment', () => {
    expect(dynamic('Object.entries(process.env);')).toEqual(['enumerate']);
    expect(dynamic('Object.keys(process.env);')).toEqual(['enumerate']);
  });

  it('reports reads through an env imported from another module', () => {
    const source = ["import { env } from './shared';", 'env.PSI;'].join('\n');
    expect(keys(source)).toEqual([]);
    expect(dynamic(source)).toEqual(['imported']);
  });

  it('reports a helper called with a name it cannot resolve', () => {
    expect(dynamic('resolvePassword({ envVar: someVariable });')).toEqual(['helper']);
    expect(dynamic('resolvePassword({});')).toEqual(['helper']);
  });

  it('does not report the helper body that indexes with its own option, nor a write', () => {
    const helper = [
      'export async function resolvePassword(options: { envVar: string; env?: NodeJS.ProcessEnv }) {',
      '  const { envVar, env = process.env } = options;',
      '  return env[envVar];',
      '}',
    ].join('\n');
    expect(scan(helper)).toEqual({ reads: [], dynamic: [] });
    expect(keys("process.env.OMICRON = 'x';")).toEqual([]);
    expect(dynamic("process.env.OMICRON = 'x';")).toEqual([]);
  });

  it('ignores an object named env that is not the process environment', () => {
    const source = [
      'interface RenderEnv { [key: string]: unknown }',
      'const IN_BLOCK = Symbol("in-block");',
      'function render(env: RenderEnv) { return env[IN_BLOCK]; }',
    ].join('\n');
    expect(scan(source)).toEqual({ reads: [], dynamic: [] });
  });
});
