import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, hashValue, newId } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { z } from 'zod';
import { author, contentWarnings, publishedSingleton, validateContent } from './commands';
import { artifactTypeEnum, artifactTypes, DEFAULT_PURPOSES } from './types';

// Installable recipes (#150): curated, versioned bundles of artifacts for the loops every
// workspace builds by hand (welcome and double opt-in, a lead-magnet drip, a weekly newsletter and
// a win-back). A recipe is data, not code: JSON files in `packages/artifacts/recipes`, validated by
// the schema below, with {{param.*}} placeholders for the person's choices and {{ref.*}} for
// references between the artifacts the recipe creates.
//
// Installing creates version 1 drafts with fresh ids, never publishes anything, and leaves the
// normal approval path (artifacts.requestPublishBundle) for the person or agent to use.

export const RECIPE_FORMAT = 'agentic-marketing/recipe@1' as const;

const ParameterKey = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]{0,40}$/)
  .describe('Used in recipe content as {{param.<key>}}');
const Duration = z.string().regex(/^P(\d+W|\d+D|T\d+H|T\d+M|\d+DT\d+H|\d+DT\d+M)$/, 'An ISO 8601 duration such as P2D, P1W or PT6H');

const ParameterTypes = ['string', 'email', 'url', 'number', 'boolean', 'duration', 'datetime'] as const;

export const RecipeParameter = z
  .object({
    key: ParameterKey,
    label: z.string().min(1).max(120),
    description: z.string().max(1000).default(''),
    type: z.enum(ParameterTypes).default('string'),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Used when the install does not pass the parameter'),
    options: z.array(z.string().max(120)).min(1).max(50).optional().describe('Allowed values for a string parameter'),
    minLength: z.number().int().min(0).max(10_000).optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    pattern: z.string().max(500).optional().describe('A regular expression the value must match'),
    min: z.number().optional().describe('Smallest allowed number'),
    max: z.number().optional().describe('Largest allowed number'),
  })
  .superRefine((p, ctx) => {
    if (p.options && p.type !== 'string')
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only a string parameter can list options' });
    if (
      (p.minLength !== undefined || p.maxLength !== undefined || p.pattern !== undefined) &&
      !['string', 'email', 'url', 'duration', 'datetime'].includes(p.type)
    )
      ctx.addIssue({ code: 'custom', message: 'minLength, maxLength and pattern apply to text parameters only' });
    if ((p.min !== undefined || p.max !== undefined) && p.type !== 'number')
      ctx.addIssue({ code: 'custom', message: 'min and max apply to a number parameter only' });
    let validPattern = true;
    if (p.pattern !== undefined) {
      try {
        new RegExp(p.pattern);
      } catch {
        validPattern = false;
        ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'pattern must be a valid regular expression' });
      }
    }
    if (p.default !== undefined && validPattern) {
      const parsed = parameterSchema(p).safeParse(p.default);
      if (!parsed.success)
        ctx.addIssue({
          code: 'custom',
          path: ['default'],
          message: `The default is not valid: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
        });
    }
  });
export type RecipeParameter = z.output<typeof RecipeParameter>;

function parameterSchema(p: Pick<RecipeParameter, 'type' | 'options' | 'minLength' | 'maxLength' | 'pattern' | 'min' | 'max'>): z.ZodType {
  let base: z.ZodType;
  switch (p.type) {
    case 'number':
      base = z.number();
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'email':
      base = z.email();
      break;
    case 'url':
      base = z.url();
      break;
    case 'duration':
      base = Duration;
      break;
    case 'datetime':
      base = z.iso.datetime({ offset: true });
      break;
    default:
      base = z.string();
  }
  if (['string', 'email', 'url', 'duration', 'datetime'].includes(p.type)) {
    let text = base as z.ZodString;
    if (p.minLength !== undefined) text = text.min(p.minLength);
    if (p.maxLength !== undefined) text = text.max(p.maxLength);
    if (p.pattern !== undefined) text = text.regex(new RegExp(p.pattern));
    if (p.options?.length) text = text.refine((value) => p.options?.includes(value), `One of: ${p.options.join(', ')}`);
    base = text;
  }
  if (p.type === 'number') {
    let n = base as z.ZodNumber;
    if (p.min !== undefined) n = n.min(p.min);
    if (p.max !== undefined) n = n.max(p.max);
    base = n;
  }
  return base;
}

export const RecipePrerequisite = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email_provider'),
    useFor: z.enum(['marketing', 'transactional']).default('marketing'),
    description: z.string().max(500).default(''),
  }),
  z.object({
    kind: z.literal('purpose'),
    purpose: z.string().min(1).max(200).describe('A purpose key; {{param.*}} placeholders are resolved first'),
    channel: z.enum(['email', 'sms', 'push', 'web']).default('email'),
    description: z.string().max(500).default(''),
  }),
]);
export type RecipePrerequisite = z.output<typeof RecipePrerequisite>;

export const RecipeArtifact = z.object({
  key: z
    .string()
    .regex(/^[a-z][A-Za-z0-9_]{0,40}$/)
    .describe('Local key, referenced from other artifacts as {{ref.<key>}}'),
  type: artifactTypeEnum,
  name: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  content: z.unknown().describe('Content for the type, with {{param.*}} and {{ref.*}} placeholders'),
});
export type RecipeArtifact = z.output<typeof RecipeArtifact>;

const PLACEHOLDER = /\{\{\s*(param|ref)\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Every {{param.*}} and {{ref.*}} in a value, as "param.key" or "ref.key". */
export function placeholdersIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) found.add(`${match[1]}.${match[2]}`);
  } else if (Array.isArray(value)) {
    for (const item of value) placeholdersIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) placeholdersIn(item, found);
  }
  return found;
}

export const Recipe = z
  .object({
    format: z.literal(RECIPE_FORMAT),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,63}$/)
      .describe('Stable recipe id, e.g. "welcome-doi"'),
    version: z.number().int().positive().describe('Bumped when the recipe changes; installs always create fresh drafts'),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(2000),
    parameters: z.array(RecipeParameter).max(30).default([]),
    prerequisites: z.array(RecipePrerequisite).max(10).default([]),
    artifacts: z.array(RecipeArtifact).min(1).max(30),
    docs: z.string().min(1).max(20_000).describe('Markdown shown in the gallery and returned by recipes.get'),
    checklist: z
      .array(z.string().min(1).max(500))
      .min(1)
      .max(30)
      .describe('What a person should review or do before publishing the drafts'),
  })
  .superRefine((recipe, ctx) => {
    const parameterKeys = new Set<string>();
    for (const [i, p] of recipe.parameters.entries()) {
      if (parameterKeys.has(p.key))
        ctx.addIssue({ code: 'custom', path: ['parameters', i, 'key'], message: `Duplicate parameter "${p.key}"` });
      parameterKeys.add(p.key);
    }
    const artifactKeys = new Set<string>();
    for (const [i, a] of recipe.artifacts.entries()) {
      if (artifactKeys.has(a.key))
        ctx.addIssue({ code: 'custom', path: ['artifacts', i, 'key'], message: `Duplicate artifact key "${a.key}"` });
      artifactKeys.add(a.key);
      const def = artifactTypes[a.type] as { singleton?: boolean; peopleOnly?: boolean; label: string };
      if (def.singleton)
        ctx.addIssue({
          code: 'custom',
          path: ['artifacts', i, 'type'],
          message: `${def.label} is one per workspace, so a recipe cannot create it. Ask a person to set it up first.`,
        });
      if (def.peopleOnly)
        ctx.addIssue({ code: 'custom', path: ['artifacts', i, 'type'], message: `${def.label} can only be created by people.` });
    }
    // Every placeholder must be declared: a typo would otherwise install as a literal {{…}}.
    const used = new Set<string>();
    for (const a of recipe.artifacts) {
      placeholdersIn(a.name, used);
      placeholdersIn(a.content, used);
    }
    for (const p of recipe.prerequisites) placeholdersIn(p, used);
    for (const value of used) {
      const [kind, key] = value.split('.') as ['param' | 'ref', string];
      if (kind === 'param' && !parameterKeys.has(key))
        ctx.addIssue({ code: 'custom', message: `The recipe uses {{param.${key}}}, but no parameter "${key}" is declared` });
      if (kind === 'ref' && !artifactKeys.has(key))
        ctx.addIssue({ code: 'custom', message: `The recipe uses {{ref.${key}}}, but no artifact with the key "${key}" exists` });
    }
  });
export type RecipeDefinition = z.output<typeof Recipe>;

const RECIPES_DIR = fileURLToPath(new URL('../recipes', import.meta.url));
let cached: RecipeDefinition[] | undefined;

/** Every recipe shipped in this build, from the JSON files in packages/artifacts/recipes. */
export function shippedRecipes(): RecipeDefinition[] {
  if (cached) return cached;
  const files = readdirSync(RECIPES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const recipes = files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(RECIPES_DIR, file), 'utf8'));
    const parsed = Recipe.safeParse(raw);
    if (!parsed.success)
      throw new AppError(
        'invalid_input',
        `The shipped recipe ${file} is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        z.treeifyError(parsed.error),
      );
    return parsed.data;
  });
  const ids = new Set<string>();
  for (const recipe of recipes) {
    if (ids.has(recipe.id)) throw new AppError('conflict', `Two shipped recipes use the id "${recipe.id}".`);
    ids.add(recipe.id);
  }
  cached = recipes;
  return recipes;
}

export function recipeById(recipeId: string): RecipeDefinition {
  const recipe = shippedRecipes().find((r) => r.id === recipeId);
  if (!recipe)
    throw new AppError(
      'not_found',
      `No recipe "${recipeId}". recipes.list shows the recipes this server ships (${shippedRecipes()
        .map((r) => r.id)
        .join(', ')}).`,
    );
  return recipe;
}

export type RecipeValues = Record<string, string | number | boolean>;

/** Fills defaults, checks types and constraints, and refuses unknown or missing required parameters. */
export function resolveParameters(recipe: RecipeDefinition, input: RecipeValues): RecipeValues {
  const declared = new Map(recipe.parameters.map((p) => [p.key, p]));
  const unknown = Object.keys(input).filter((key) => !declared.has(key));
  const problems: string[] = [];
  if (unknown.length) problems.push(`Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  const values: RecipeValues = {};
  for (const p of recipe.parameters) {
    const value = input[p.key] ?? p.default;
    if (value === undefined) {
      if (p.required) problems.push(`${p.key} is required`);
      continue;
    }
    const parsed = parameterSchema(p).safeParse(value);
    if (!parsed.success) problems.push(`${p.key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
    else values[p.key] = parsed.data as string | number | boolean;
  }
  if (problems.length)
    throw new AppError('invalid_input', `The parameters for "${recipe.id}" are not valid: ${problems.join('; ')}.`, { problems });
  return values;
}

const OMIT = Symbol('omit');

function placeholderValue(namespace: 'param' | 'ref', key: string, params: RecipeValues, refs: Record<string, string>): string | undefined {
  if (namespace === 'param') {
    const value = params[key];
    return value === undefined ? undefined : String(value);
  }
  const value = refs[key];
  if (value === undefined)
    throw new AppError('invalid_input', `The recipe refers to {{ref.${key}}}, but no artifact with that key is created.`);
  return value;
}

/** Replaces placeholders in one string; a whole-string placeholder with no value is omitted. */
export function substituteString(text: string, params: RecipeValues, refs: Record<string, string>): string | typeof OMIT {
  const whole = /^\{\{\s*(param|ref)\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(text);
  if (whole) {
    const value = placeholderValue(whole[1] as 'param' | 'ref', whole[2]!, params, refs);
    return value === undefined ? OMIT : value;
  }
  return text.replace(PLACEHOLDER, (_all, namespace: 'param' | 'ref', key: string) => {
    const value = placeholderValue(namespace, key, params, refs);
    if (value === undefined) throw new AppError('invalid_input', `The recipe uses {{${namespace}.${key}}}, but it has no value.`);
    return value;
  });
}

/** Replaces placeholders throughout a JSON value; object keys whose whole value is omitted are dropped. */
export function substitute(value: unknown, params: RecipeValues, refs: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const out = substituteString(value, params, refs);
    return out === OMIT ? OMIT : out;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, params, refs)).filter((item) => item !== OMIT);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = substitute(item, params, refs);
      if (next !== OMIT) out[key] = next;
    }
    return out;
  }
  return value;
}

export interface ResolvedRecipeArtifact {
  key: string;
  id: string;
  type: RecipeArtifact['type'];
  name: string;
  note: string;
  content: Record<string, unknown>;
  warnings: { nodeId: string | null; path: string; message: string }[];
}

/**
 * Resolves one recipe into drafts: fresh ids for every artifact, references between them and the
 * parameters filled in. Validation is the same draft validation artifacts.create applies, so a
 * resolved recipe is safe to write.
 */
export function resolveRecipe(
  recipe: RecipeDefinition,
  params: RecipeValues,
  idFor: (type: RecipeArtifact['type']) => string = (type) => newId(artifactTypes[type].prefix),
) {
  const refs: Record<string, string> = {};
  for (const a of recipe.artifacts) refs[a.key] = idFor(a.type);
  return recipe.artifacts.map((a): ResolvedRecipeArtifact => {
    const name = substituteString(a.name, params, refs);
    if (name === OMIT) throw new AppError('invalid_input', `The name of "${a.key}" must not be only an optional placeholder.`);
    const content = substitute(a.content, params, refs) as Record<string, unknown>;
    validateContent(a.type, content, 'draft');
    return {
      key: a.key,
      id: refs[a.key]!,
      type: a.type,
      name,
      note: a.note ?? `Installed from recipe ${recipe.id} v${recipe.version}`,
      content,
      warnings: contentWarnings(a.type, content),
    };
  });
}

export const PrerequisiteResult = z.object({
  kind: z.string(),
  description: z.string(),
  ok: z.boolean(),
  message: z.string(),
});

export async function checkPrerequisites(
  tx: Tx,
  recipe: RecipeDefinition,
  params: RecipeValues,
): Promise<z.output<typeof PrerequisiteResult>[]> {
  const results: z.output<typeof PrerequisiteResult>[] = [];
  for (const p of recipe.prerequisites) {
    if (p.kind === 'email_provider') {
      const rows = await tx
        .select({ enabled: schema.emailProviders.enabled, useFor: schema.emailProviders.useFor })
        .from(schema.emailProviders);
      const ok = rows.some((row) => row.enabled && row.useFor.includes(p.useFor));
      results.push({
        kind: p.kind,
        description: p.description || `An enabled e-mail provider for ${p.useFor} e-mail`,
        ok,
        message: ok
          ? `An e-mail provider is set up for ${p.useFor} mail.`
          : `No enabled e-mail provider is set up for ${p.useFor} mail. Add one in Settings → Providers (emailProviders.create with useFor: ["${p.useFor}"]).`,
      });
    } else {
      const purpose = substituteString(p.purpose, params, {});
      if (purpose === OMIT) {
        results.push({
          kind: p.kind,
          description: p.description || 'A configured purpose',
          ok: false,
          message: 'The purpose parameter has no value.',
        });
        continue;
      }
      const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
      const found = purposes.find((x) => x.key === purpose);
      const ok = !!found && found.channels.includes(p.channel);
      results.push({
        kind: p.kind,
        description: p.description || `The purpose "${purpose}" includes the ${p.channel} channel`,
        ok,
        message: ok
          ? `The purpose "${purpose}" is configured for ${p.channel}.`
          : found
            ? `The purpose "${purpose}" does not include the ${p.channel} channel. Change the purpose artifact (Settings → Purposes) or install with another purpose.`
            : `The purpose "${purpose}" is not configured. Add it to the purposes artifact (Settings → Purposes) or install with a configured purpose.`,
      });
    }
  }
  return results;
}

const RecipeParams = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .default({})
  .describe('Parameter values by key; defaults fill the rest');

const RecipeSummary = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  description: z.string(),
  artifacts: z.number().int().describe('How many drafts an install creates'),
  parameters: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(ParameterTypes),
      required: z.boolean(),
      default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }),
  ),
  prerequisites: z.number().int(),
});

export const listRecipes = defineCommand({
  name: 'recipes.list',
  title: 'List installable recipes',
  description:
    'Curated, versioned recipes for common marketing loops (welcome and double opt-in, lead-magnet drip, weekly newsletter, win-back). Each install creates drafts with fresh ids and never publishes; read one with recipes.get and try parameters with recipes.preview.',
  input: z.object({}),
  output: z.object({ recipes: z.array(RecipeSummary) }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async () => ({
    recipes: shippedRecipes().map((recipe) => ({
      id: recipe.id,
      version: recipe.version,
      title: recipe.title,
      description: recipe.description,
      artifacts: recipe.artifacts.length,
      parameters: recipe.parameters.map((p) => ({ key: p.key, label: p.label, type: p.type, required: p.required, default: p.default })),
      prerequisites: recipe.prerequisites.length,
    })),
  }),
});

export const getRecipe = defineCommand({
  name: 'recipes.get',
  title: 'Get a recipe',
  description: 'One recipe with its parameters, prerequisites, artifact content, documentation and review checklist.',
  input: z.object({ recipeId: z.string().min(1).max(80) }),
  output: z.object({ recipe: Recipe }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input) => ({ recipe: recipeById(input.recipeId) }),
});

const ResolvedArtifactOut = z.object({
  key: z.string(),
  id: z
    .string()
    .describe('A preview id that shows how references resolve; the install generates fresh ids and writes nothing in a preview'),
  type: z.string(),
  name: z.string(),
  content: z.unknown(),
  warnings: z.array(z.object({ nodeId: z.string().nullable(), path: z.string(), message: z.string() })),
});

export const previewRecipe = defineCommand({
  name: 'recipes.preview',
  title: 'Preview a recipe install',
  description:
    'Read-only: resolves the parameters, checks the prerequisites (e.g. an e-mail provider for marketing and a configured purpose) and shows the drafts an install would create, with references between them resolved. Writes nothing.',
  input: z.object({ recipeId: z.string().min(1).max(80), params: RecipeParams }),
  output: z.object({
    recipe: z.object({ id: z.string(), version: z.number().int(), title: z.string() }),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    prerequisites: z.array(PrerequisiteResult),
    ready: z.boolean().describe('True when every prerequisite is met'),
    artifacts: z.array(ResolvedArtifactOut),
    checklist: z.array(z.string()),
    docs: z.string(),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const recipe = recipeById(input.recipeId);
    const params = resolveParameters(recipe, input.params);
    const prerequisites = await checkPrerequisites(ctx.tx, recipe, params);
    const artifacts = resolveRecipe(recipe, params);
    return {
      recipe: { id: recipe.id, version: recipe.version, title: recipe.title },
      params,
      prerequisites,
      ready: prerequisites.every((p) => p.ok),
      artifacts,
      checklist: recipe.checklist,
      docs: recipe.docs,
    };
  },
});

export const installRecipe = defineCommand({
  name: 'recipes.install',
  title: 'Install a recipe as drafts',
  description:
    'Creates the recipe’s artifacts as version 1 drafts with fresh ids, with parameters filled and references between the new drafts resolved. Never publishes: review the drafts and submit them (usually together with artifacts.requestPublishBundle), so the workspace approval policy decides. Installing the same recipe again creates another set of drafts.',
  input: z.object({ recipeId: z.string().min(1).max(80), params: RecipeParams }),
  output: z.object({
    recipeId: z.string(),
    version: z.number().int(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    artifacts: z.array(
      z.object({
        key: z.string(),
        artifactId: z.string(),
        type: z.string(),
        name: z.string(),
        version: z.number().int(),
        state: z.literal('draft'),
      }),
    ),
    prerequisites: z.array(PrerequisiteResult),
    checklist: z.array(z.string()),
    next: z.string().describe('What to do after the drafts exist'),
  }),
  permission: 'artifacts:write',
  effect: 'write',
  actionClass: 'draft',
  handler: async (input, ctx) => {
    const recipe = recipeById(input.recipeId);
    const params = resolveParameters(recipe, input.params);
    const prerequisites = await checkPrerequisites(ctx.tx, recipe, params);
    const failed = prerequisites.filter((p) => !p.ok);
    if (failed.length)
      throw new AppError('invalid_input', `Cannot install "${recipe.title}" yet: ${failed.map((p) => p.message).join(' ')}`, {
        prerequisites: failed,
      });
    const artifacts = resolveRecipe(recipe, params);
    const ws = ctx.principal.workspaceId;
    for (const a of artifacts) {
      const def = artifactTypes[a.type] as { singleton?: boolean; peopleOnly?: boolean };
      if (def.singleton || def.peopleOnly) throw new AppError('forbidden', `A recipe cannot create ${a.type}; ask a person to create it.`);
      await ctx.tx.insert(schema.artifacts).values({ workspaceId: ws, id: a.id, type: a.type, name: a.name, latestVersion: 1 });
      await ctx.tx.insert(schema.artifactVersions).values({
        workspaceId: ws,
        artifactId: a.id,
        number: 1,
        state: 'draft',
        content: a.content,
        contentHash: hashValue(a.content),
        note: a.note,
        ...author(ctx),
      });
    }
    return {
      recipeId: recipe.id,
      version: recipe.version,
      params,
      artifacts: artifacts.map((a) => ({
        key: a.key,
        artifactId: a.id,
        type: a.type,
        name: a.name,
        version: 1,
        state: 'draft' as const,
      })),
      prerequisites,
      checklist: recipe.checklist,
      next: `Review the ${artifacts.length} drafts, fill anything the checklist asks for, then submit them together with artifacts.requestPublishBundle. The approval policy decides; an install never publishes.`,
    };
  },
});

export const recipeCommands = [listRecipes, getRecipe, previewRecipe, installRecipe] as const;
