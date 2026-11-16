import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';

// A syntax-aware scan of the environment the server reads (#965 review A): `process.env.X` is only
// the obvious spelling. The code also reads an environment object through a variable, a default
// parameter, a parameter typed `NodeJS.ProcessEnv` or `Record<string, string | undefined>`, a
// destructuring pattern, a constant key and known helper functions that take the variable name.
// This parses the file and resolves those, and reports an access it cannot reduce to a name so a
// genuinely dynamic read needs an explicit, reasoned exception instead of silently escaping the
// deployment guard.
//
// The parser is @babel/parser rather than the TypeScript compiler API: `typescript` 7 in this repo
// is the native (tsgo) package and ships no `createSourceFile`, so its AST cannot be built here.

export interface EnvNameRead {
  /** The environment variable name. */
  key: string;
  /** The file that reads it. */
  file: string;
}

export interface DynamicEnvRead {
  file: string;
  /** 1-based line of the access. */
  line: number;
  /**
   * `element`: an index expression whose key is not a literal or a constant string.
   * `enumerate`: `Object.entries/keys/values` over the environment object.
   * `helper`: a known helper called with a variable name that is not a literal or a constant.
   */
  kind: 'element' | 'enumerate' | 'helper';
  /** The access as written, for the failure message. */
  text: string;
}

export interface EnvScan {
  reads: EnvNameRead[];
  dynamic: DynamicEnvRead[];
}

/**
 * Functions that read the one variable their option names. Their own body indexes the environment
 * with that option, so the scan follows the option at every call site instead (and does not report
 * the body as a dynamic read).
 */
export const ENV_HELPERS = new Map([['resolvePassword', 'envVar']]);

/** A file to scan, with its path relative to the repository root. */
export interface SourceInput {
  file: string;
  source: string;
}

// Babel's AST is untyped here: only a handful of node shapes matter, and naming them all would be
// more code than the scan itself.
type Ast = any;

export function scanEnvReads(input: SourceInput): EnvScan {
  const ast = parse(input.source, {
    sourceType: 'module',
    plugins: input.file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  }) as Ast;

  const parents = new Map<Ast, Ast>();
  walk(ast, (node, parent) => {
    if (parent) parents.set(node, parent);
  });

  const lines = new Map<number, number>();
  const lineOf = (offset: number): number => {
    let cached = lines.get(offset);
    if (cached === undefined) {
      cached = input.source.slice(0, offset).split('\n').length;
      lines.set(offset, cached);
    }
    return cached;
  };

  const envTypes = envTypeAliases(ast, input.source);
  const bindings = new Set<string>();
  const constants = stringConstants(ast);

  /** An environment object handed around under another name: `const env = process.env`,
   * `opts.env ?? process.env`, `{ ...process.env }`, a default parameter, or a parameter typed as
   * an environment map. */
  const yieldsEnvObject = (expression: Ast): boolean => {
    const node = unwrap(expression);
    if (!node) return false;
    if (isProcessEnv(node)) return true;
    if (node.type === 'LogicalExpression' && ['??', '||', '&&'].includes(node.operator))
      return yieldsEnvObject(node.left) || yieldsEnvObject(node.right);
    if (node.type === 'ConditionalExpression') return yieldsEnvObject(node.consequent) || yieldsEnvObject(node.alternate);
    if (node.type === 'ObjectExpression')
      return node.properties.some((p: Ast) => p.type === 'SpreadElement' && yieldsEnvObject(p.argument));
    return false;
  };

  const bind = (pattern: Ast): void => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') bindings.add(pattern.name);
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left);
    else if (pattern.type === 'RestElement') bind(pattern.argument);
  };

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') {
      if (node.init && yieldsEnvObject(node.init)) bind(node.id);
      return;
    }
    // `const { env = process.env } = options`.
    if (node.type === 'AssignmentPattern' && node.right && yieldsEnvObject(node.right)) {
      bind(node.left);
      return;
    }
    if (isFunctionLike(node)) {
      for (const parameter of node.params) {
        const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
        if (target.type !== 'Identifier') continue;
        const defaultsToEnv = parameter.type === 'AssignmentPattern' && yieldsEnvObject(parameter.right);
        // Only a parameter *named* `env` counts on its type alone: a header map or an options bag
        // shares the `Record<string, string | undefined>` / `NodeJS.ProcessEnv` shape, and binding
        // those would report their keys as environment variables.
        const typedAsEnv = target.name === 'env' && isEnvType(target.typeAnnotation?.typeAnnotation, envTypes, input.source);
        if (defaultsToEnv || typedAsEnv) bindings.add(target.name);
      }
    }
  });

  const isEnvRef = (expression: Ast): boolean => {
    const node = unwrap(expression);
    if (!node) return false;
    if (isProcessEnv(node)) return true;
    return node.type === 'Identifier' && bindings.has(node.name);
  };

  /** A key expression that is a literal or a constant string, or undefined when it is dynamic. */
  const keyOf = (expression: Ast): string | undefined => {
    const node = unwrap(expression);
    if (!node) return undefined;
    if (node.type === 'StringLiteral') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
    if (node.type === 'Identifier') return constants.get(node.name);
    return undefined;
  };

  const reads: EnvNameRead[] = [];
  const dynamic: DynamicEnvRead[] = [];
  const add = (key: string) => reads.push({ key, file: input.file });
  const addDynamic = (node: Ast, kind: DynamicEnvRead['kind']) => {
    if (kind === 'element' && ENV_HELPERS.has(enclosingFunctionName(node, parents) ?? '')) return;
    dynamic.push({
      file: input.file,
      line: lineOf(node.start),
      kind,
      text: input.source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 120),
    });
  };

  walk(ast, (node) => {
    if (node.type === 'MemberExpression' && isEnvRef(node.object) && !isWriteTarget(node, parents)) {
      if (!node.computed && node.property.type === 'Identifier') {
        add(node.property.name);
        return;
      }
      const key = keyOf(node.property);
      if (key) add(key);
      else addDynamic(node, 'element');
      return;
    }
    // `const { ALPHA, BETA: renamed } = process.env`
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init && isEnvRef(node.init)) {
      for (const property of node.id.properties) {
        if (property.type === 'RestElement') {
          addDynamic(property, 'element');
          continue;
        }
        const key = property.computed ? keyOf(property.key) : propertyName(property.key);
        if (key) add(key);
        else addDynamic(property, 'element');
      }
      return;
    }
    if (node.type !== 'CallExpression') return;

    // Enumerating every name is a read the scan cannot resolve, by construction.
    if (
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'Object' &&
      node.callee.property.type === 'Identifier' &&
      ['entries', 'keys', 'values'].includes(node.callee.property.name) &&
      node.arguments[0] &&
      isEnvRef(node.arguments[0])
    ) {
      addDynamic(node, 'enumerate');
      return;
    }
    // A known helper: `resolvePassword({ envVar: 'AM_BOOTSTRAP_PASSWORD' })`.
    if (node.callee.type !== 'Identifier') return;
    const option = ENV_HELPERS.get(node.callee.name);
    if (!option) return;
    const argument = unwrap(node.arguments[0]);
    const property = argument?.type === 'ObjectExpression' ? propertyNamed(argument, option) : undefined;
    const key = property && keyOf(property);
    if (key) add(key);
    else addDynamic(node, 'helper');
  });

  return { reads, dynamic };
}

/** Scans every server-side source file under `apps/server/src` and `packages/<name>/src`. */
export async function scanServerSources(root: string): Promise<EnvScan> {
  const reads: EnvNameRead[] = [];
  const dynamic: DynamicEnvRead[] = [];
  for (const file of await serverSourceFiles(root)) {
    const scan = scanEnvReads({ file, source: await readFile(join(root, file), 'utf8') });
    reads.push(...scan.reads);
    dynamic.push(...scan.dynamic);
  }
  return { reads, dynamic };
}

/**
 * The TypeScript the server image runs: apps/server/src and every package's src. Tests are not
 * deployed and the admin UI runs in the browser, so both are out of scope.
 */
export async function serverSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // a package without src/
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
      found.push(relative(root, path));
    }
  };
  await walk(join(root, 'apps/server/src'));
  for (const space of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (space.isDirectory()) await walk(join(root, 'packages', space.name, 'src'));
  }
  return found;
}

/** `process.env` and `process['env']`. */
function isProcessEnv(node: Ast): boolean {
  if (node?.type !== 'MemberExpression' || node.object?.type !== 'Identifier' || node.object.name !== 'process') return false;
  if (!node.computed) return node.property?.type === 'Identifier' && node.property.name === 'env';
  return node.property?.type === 'StringLiteral' && node.property.value === 'env';
}

/** Strips the wrappers that do not change the value. */
function unwrap(node: Ast): Ast {
  let current = node;
  while (
    current &&
    ['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(current.type)
  )
    current = current.expression;
  return current;
}

/** Whether the node is assigned to (a write, not a read). */
function isWriteTarget(node: Ast, parents: Map<Ast, Ast>): boolean {
  const parent = parents.get(node);
  if (!parent) return false;
  if (parent.type === 'AssignmentExpression' && parent.left === node) return true;
  if (parent.type === 'UpdateExpression') return true;
  return parent.type === 'UnaryExpression' && parent.operator === 'delete';
}

function isFunctionLike(node: Ast): boolean {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'].includes(node.type);
}

/** The property of an object literal with that name, when written as a plain `name: value`. */
function propertyNamed(object: Ast, name: string): Ast | undefined {
  for (const property of object.properties) {
    if (property.type !== 'ObjectProperty' || property.computed) continue;
    if (propertyName(property.key) === name) return property.value;
  }
  return undefined;
}

/** The name a non-computed property key stands for. */
function propertyName(key: Ast): string | undefined {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return undefined;
}

/** Every identifier in the file whose name is declared with one string literal, and no other. */
function stringConstants(ast: Ast): Map<string, string> {
  const seen = new Map<string, string | null>();
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
    const value = unwrap(node.init);
    const text =
      value?.type === 'StringLiteral'
        ? value.value
        : value?.type === 'TemplateLiteral' && value.expressions.length === 0
          ? value.quasis[0]?.value.cooked
          : undefined;
    if (text === undefined) return;
    const previous = seen.get(node.id.name);
    // A second declaration with a different value makes the name ambiguous: treat it as dynamic.
    seen.set(node.id.name, previous === undefined || previous === text ? text : null);
  });
  const out = new Map<string, string>();
  for (const [name, value] of seen) if (value !== null) out.set(name, value);
  return out;
}

/** Type names in this file that mean an environment map, including local aliases of them. */
function envTypeAliases(ast: Ast, source: string): Set<string> {
  const aliases: { name: string; type: Ast }[] = [];
  walk(ast, (node) => {
    if (node.type === 'TSTypeAliasDeclaration') aliases.push({ name: node.id.name, type: node.typeAnnotation });
  });
  const envTypes = new Set<string>();
  let changed = true;
  // Aliases can chain (`type Env = Base`), so resolve until a pass adds nothing.
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      if (envTypes.has(alias.name) || !isEnvType(alias.type, envTypes, source)) continue;
      envTypes.add(alias.name);
      changed = true;
    }
  }
  return envTypes;
}

function isEnvType(node: Ast, envTypes: Set<string>, source: string): boolean {
  // Only a reference to an environment-map type qualifies: an object type that happens to contain a
  // `ProcessEnv` property (an options bag) is not itself the environment.
  if (node?.type !== 'TSTypeReference') return false;
  const text = source.slice(node.start, node.end);
  if (/Record\s*<\s*string\s*,\s*string\s*\|\s*undefined\s*>/.test(text)) return true;
  const name = source.slice(node.typeName.start, node.typeName.end);
  return name === 'NodeJS.ProcessEnv' || name === 'ProcessEnv' || envTypes.has(name);
}

/** The name of the function a node sits in, when it has one. */
function enclosingFunctionName(node: Ast, parents: Map<Ast, Ast>): string | undefined {
  for (let current = parents.get(node); current; current = parents.get(current)) {
    if (current.type === 'FunctionDeclaration' || current.type === 'ObjectMethod' || current.type === 'ClassMethod')
      return current.id?.type === 'Identifier' ? current.id.name : current.key && propertyName(current.key);
    if (current.type === 'FunctionExpression') return current.id?.name;
    if (current.type === 'ArrowFunctionExpression') {
      const parent = parents.get(current);
      if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
      if (parent?.type === 'ObjectProperty') return propertyName(parent.key);
    }
  }
  return undefined;
}

/** Visits every AST node, skipping the locations and attached comments Babel adds. */
function walk(node: Ast, visit: (node: Ast, parent?: Ast) => void, parent?: Ast): void {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key.endsWith('Comments')) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, node);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, node);
    }
  }
}
