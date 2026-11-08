import { describe, expect, it } from 'vitest';
import { shippedRecipes } from '../src/index';

// Phase 27 (#529): the starter recipes keep the same content, parameters and Liquid links, with a
// renewed e-mail hierarchy: a 600 px body, brand name, 24/32 heading, 16/26 reading text, a rule
// and a 13/20 footer. No starter uses an image, so blocked images leave readable live text.

type EmailContent = {
  subject: string;
  preheader?: string;
  mjml: string;
  sampleData?: Record<string, unknown>;
};

const recipes = shippedRecipes();
const emailTemplates = (recipe: (typeof recipes)[number]) =>
  recipe.artifacts.filter((a) => a.type === 'email_template').map((a) => ({ key: a.key, content: a.content as unknown as EmailContent }));

const expectedSubject: Record<string, Record<string, string>> = {
  'lead-magnet-drip': {
    deliverEmail: 'Here is {{param.magnetName}}',
    teachEmail: 'One way to use {{param.magnetName}} this week',
    proveEmail: 'What this looks like in practice',
    inviteEmail: 'Want to go one step further?',
  },
  'weekly-newsletter': { newsletterTemplate: '{{param.subject}}' },
  'welcome-doi': {
    confirmTemplate: 'Confirm your subscription to {{param.siteName}}',
    welcomeEmail: 'Welcome to {{param.siteName}}',
    followUpEmail: 'Start here: the three things worth reading',
  },
  'win-back': { checkInEmail: 'Did something change?', comeBackEmail: 'A way back, if you want it' },
};

describe('starter e-mail templates stay complete and responsive (#529)', () => {
  it('ships the same four recipes and every e-mail keeps its subject', () => {
    expect(recipes.map((r) => r.id)).toEqual(['lead-magnet-drip', 'weekly-newsletter', 'welcome-doi', 'win-back']);
    for (const recipe of recipes) {
      for (const { key, content } of emailTemplates(recipe)) {
        expect(content.subject, `${recipe.id}/${key}`).toBe(expectedSubject[recipe.id]?.[key]);
      }
    }
  });

  it('uses one 600 px body, a brand line, a 24/32 heading and 16/26 reading text', () => {
    for (const recipe of recipes) {
      for (const { key, content } of emailTemplates(recipe)) {
        expect(content.mjml, `${recipe.id}/${key}`).toContain('<mj-body width="600px"');
        expect(content.mjml, `${recipe.id}/${key}`).toContain('font-size="24px" line-height="32px"');
        expect(content.mjml, `${recipe.id}/${key}`).toContain('font-size="16px" line-height="26px"');
        expect(content.mjml, `${recipe.id}/${key}`).toContain('<mj-divider');
        expect(content.mjml, `${recipe.id}/${key}`).toContain('font-size="13px" line-height="20px"');
      }
    }
  });

  it('keeps live text and no image that could be blocked', () => {
    for (const recipe of recipes) {
      for (const { key, content } of emailTemplates(recipe)) {
        expect(content.mjml, `${recipe.id}/${key}`).not.toContain('<mj-image');
        expect(content.mjml, `${recipe.id}/${key}`).not.toContain('<img');
        expect(content.mjml, `${recipe.id}/${key}`).toContain('Hi {{ profile.firstName | default: "there" }},');
      }
    }
  });

  it('keeps every Liquid link and visible link text', () => {
    for (const recipe of recipes) {
      for (const { key, content } of emailTemplates(recipe)) {
        const label = `${recipe.id}/${key}`;
        if (recipe.id === 'welcome-doi' && key === 'confirmTemplate') {
          expect(content.mjml, label).toContain('href="{{ confirm_url | raw }}"');
        } else {
          expect(content.mjml, label).toContain('href="{{ preferences_url | raw }}">Manage preferences</a>');
          expect(content.mjml, label).toContain('href="{{ unsubscribe_url | raw }}">unsubscribe</a>');
        }
      }
    }
  });

  it('keeps the existing web-version buttons and parameters', () => {
    const weekly = emailTemplates(recipes.find((r) => r.id === 'weekly-newsletter')!).find((t) => t.key === 'newsletterTemplate')!;
    expect(weekly.content.mjml).toContain('href="{{ web_url | raw }}"');
    expect(weekly.content.mjml).toContain('{{param.issueTitle}}');

    const winBack = emailTemplates(recipes.find((r) => r.id === 'win-back')!).find((t) => t.key === 'comeBackEmail')!;
    expect(winBack.content.mjml).toContain('href="{{ web_url | raw }}"');
    expect(winBack.content.mjml).toContain('{{param.offerCode}}');
  });

  it('keeps the original body copy of every starter', () => {
    const copy: Record<string, string[]> = {
      deliverEmail: ['Thanks for asking for {{param.magnetName}}. You can download it here:'],
      teachEmail: ['Pick the item that made you wince. Write down why. Change only that one thing before Friday.'],
      proveEmail: ['Before: the same message went to everyone, once, with no follow-up.'],
      inviteEmail: ['No pitch: bring one question and we will work through it.'],
      newsletterTemplate: ['Worth knowing.', 'Worth trying.', 'Worth asking.'],
      confirmTemplate: ['Please confirm that you want to hear from {{param.siteName}}.'],
      welcomeEmail: ['You are on the list, and we are glad you are here.'],
      followUpEmail: ['The guide that explains the basics.'],
      checkInEmail: ['Did something change: the product, the price, or what you needed?'],
      comeBackEmail: ['Use the code <strong>{{param.offerCode}}</strong> at checkout.'],
    };
    for (const recipe of recipes) {
      for (const { key, content } of emailTemplates(recipe)) {
        for (const text of copy[key] ?? []) expect(content.mjml, `${recipe.id}/${key}: ${text}`).toContain(text);
      }
    }
  });

  it('keeps sample data for previews', () => {
    for (const recipe of recipes) {
      for (const { key, content } of emailTemplates(recipe)) {
        expect(content.sampleData, `${recipe.id}/${key}`).toEqual({ profile: { firstName: 'Ada' } });
      }
    }
  });
});
