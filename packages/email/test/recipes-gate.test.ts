import { type EmailTemplate, shippedRecipes } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { emailPublishProblems } from '../src/checks';
import { validateTemplate } from '../src/render';

// The stricter visible-unsubscribe predicate (#637 review) must not break a template that already
// ships. Every e-mail in packages/artifacts/recipes is validated and rendered here; a marketing
// one must pass the same gate a workspace template does.

const recipes = shippedRecipes();
const emailTemplates = recipes.flatMap((recipe) =>
  recipe.artifacts
    .filter((a) => a.type === 'email_template')
    .map((a) => ({ id: `${recipe.id}/${a.key}`, content: a.content as unknown as EmailTemplate })),
);

describe('the shipped starter recipes pass the unsubscribe gate', () => {
  it('finds every recipe e-mail', () => {
    expect(emailTemplates.length).toBeGreaterThanOrEqual(10);
  });

  it.each(emailTemplates)('$id', async ({ content }) => {
    // Recipe e-mails carry {{param.purpose}} until install; the real key is a marketing purpose.
    const purpose = content.purpose === '{{param.purpose}}' ? 'marketing_email' : content.purpose;
    const t = { ...content, purpose } as EmailTemplate;
    const marketing = purpose !== 'onboarding' && purpose !== 'necessary';
    await expect(validateTemplate(t)).resolves.toEqual([]);
    await expect(emailPublishProblems(t, { marketing })).resolves.toEqual([]);
  });
});
