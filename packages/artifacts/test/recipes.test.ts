import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { placeholdersIn, Recipe, resolveParameters, resolveRecipe, shippedRecipes, substitute, validateContent } from '../src/index';

// Recipes (#150) are data: JSON files in packages/artifacts/recipes, read by the server and shipped
// in the image. These tests keep the shipped files honest: every one matches the schema, every
// placeholder is declared, and resolving a recipe with its defaults gives content that passes the
// publish-time content validation for its artifact type.

const recipesDir = fileURLToPath(new URL('../recipes', import.meta.url));
const files = readdirSync(recipesDir)
  .filter((file) => file.endsWith('.json'))
  .sort();

describe('shipped recipes', () => {
  it('ships the four initial recipes', () => {
    expect(shippedRecipes().map((r) => r.id)).toEqual(['lead-magnet-drip', 'weekly-newsletter', 'welcome-doi', 'win-back']);
  });

  it('every JSON file in packages/artifacts/recipes matches the schema and is registered', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    const registered = new Set(shippedRecipes().map((r) => r.id));
    for (const file of files) {
      const raw: unknown = JSON.parse(readFileSync(join(recipesDir, file), 'utf8'));
      const parsed = Recipe.safeParse(raw);
      expect(parsed.success, `${file}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.format, file).toBe('agentic-marketing/recipe@1');
        expect(parsed.data.version, file).toBeGreaterThan(0);
        expect(registered.has(parsed.data.id), `${file} is not in shippedRecipes()`).toBe(true);
      }
    }
  });

  it('uses unique ids and declares every {{param.*}} and {{ref.*}}', () => {
    const recipes = shippedRecipes();
    expect(new Set(recipes.map((r) => r.id)).size).toBe(recipes.length);
    for (const recipe of recipes) {
      const params = new Set(recipe.parameters.map((p) => p.key));
      const refs = new Set(recipe.artifacts.map((a) => a.key));
      const used = new Set<string>();
      for (const artifact of recipe.artifacts) {
        placeholdersIn(artifact.name, used);
        placeholdersIn(artifact.content, used);
      }
      for (const prerequisite of recipe.prerequisites) placeholdersIn(prerequisite, used);
      for (const placeholder of used) {
        const [kind, key] = placeholder.split('.') as ['param' | 'ref', string];
        if (kind === 'param') expect(params.has(key), `${recipe.id}: ${placeholder} is not declared`).toBe(true);
        else expect(refs.has(key), `${recipe.id}: ${placeholder} is not an artifact`).toBe(true);
      }
    }
  });

  it('resolves with defaults to drafts that pass publish-time content validation', () => {
    for (const recipe of shippedRecipes()) {
      const params = resolveParameters(recipe, {});
      const artifacts = resolveRecipe(recipe, params);
      expect(artifacts).toHaveLength(recipe.artifacts.length);
      expect(new Set(artifacts.map((a) => a.id)).size).toBe(artifacts.length);
      const ids = new Set(artifacts.map((a) => a.id));
      for (const artifact of artifacts) {
        // The same check artifacts.create runs for drafts, then the stricter publish schema.
        expect(() => validateContent(artifact.type, artifact.content, 'draft'), `${recipe.id}/${artifact.key}`).not.toThrow();
        expect(() => validateContent(artifact.type, artifact.content, 'publish'), `${recipe.id}/${artifact.key}`).not.toThrow();
        // No placeholder may leak into stored content.
        const serialized = JSON.stringify(artifact.content);
        expect(serialized, `${recipe.id}/${artifact.key}`).not.toMatch(/\{\{\s*(param|ref)\./);
        // References between the new drafts point at ids from the same install.
        for (const value of Object.values(artifact.content)) {
          if (typeof value !== 'string' || !/^(eml|seg|jrn|bct|frm)_/.test(value)) continue;
          expect(ids.has(value), `${recipe.id}/${artifact.key} refers to ${value}`).toBe(true);
        }
      }
    }
  });

  it('drops an optional whole-string placeholder instead of writing an empty date', () => {
    const recipe = shippedRecipes().find((r) => r.id === 'weekly-newsletter');
    expect(recipe).toBeDefined();
    if (!recipe) return;
    const without = resolveRecipe(recipe, resolveParameters(recipe, {})).find((a) => a.key === 'newsletterBroadcast');
    expect(without?.content.sendAt).toBeUndefined();
    const withDate = resolveRecipe(recipe, resolveParameters(recipe, { sendAt: '2026-11-06T07:00:00Z' })).find(
      (a) => a.key === 'newsletterBroadcast',
    );
    expect(withDate?.content.sendAt).toBe('2026-11-06T07:00:00Z');
  });

  it('validates parameter types, defaults and unknown keys', () => {
    const recipe = shippedRecipes().find((r) => r.id === 'lead-magnet-drip');
    expect(recipe).toBeDefined();
    if (!recipe) return;
    const defaults = resolveParameters(recipe, {});
    expect(defaults).toMatchObject({ siteName: 'Your site', magnetName: 'the guide', delay: 'P2D' });
    expect(() => resolveParameters(recipe, { unknown: 'x' })).toThrow(/Unknown parameter/);
    expect(() => resolveParameters(recipe, { delay: 'two days' })).toThrow(/delay/);
    expect(() => resolveParameters(recipe, { siteName: '' })).toThrow(/siteName/);
    expect(() => resolveParameters(recipe, { magnetUrl: 'not a url' })).toThrow(/magnetUrl/);
    expect(resolveParameters(recipe, { siteName: 'Fjeldvej' }).siteName).toBe('Fjeldvej');
  });

  it('does not substitute Liquid variables that are not recipe placeholders', () => {
    const out = substitute('Hi {{ profile.firstName | default: "there" }}', {}, {});
    expect(out).toBe('Hi {{ profile.firstName | default: "there" }}');
  });
});
