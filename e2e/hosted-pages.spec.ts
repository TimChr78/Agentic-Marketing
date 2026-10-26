import { expect, type Page, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

// The hosted pages a subscriber clicks through (#115). These run in a real browser on purpose:
// the browser enforces the page's CSP (form-action also covers the redirect after a POST), which
// a plain HTTP client never does. The seeded server signs the links on a test-only side port.

const base = process.env.E2E_BASE ?? 'http://localhost:3100';
const fixtures = process.env.E2E_FIXTURES ?? `http://127.0.0.1:${Number(new URL(base).port || 80) + 1}`;
const SITE = 'https://martechsignal.example';

/** Signs up like the site's form does and returns the confirmation link from the "e-mail". */
async function signUp(page: Page, form: string, email: string) {
  const anonymousId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const submitted = await page.request.post(`/f/${form}`, {
    form: { email, anonymousId },
    headers: { origin: SITE },
    maxRedirects: 0,
  });
  expect(submitted.status()).toBe(303);
  const r = await page.request.post(`${fixtures}/confirm-link`, { data: { form, anonymousId } });
  return ((await r.json()) as { url: string }).url;
}

async function consentOf(page: Page, email: string) {
  let profileId: string | null = null;
  await expect
    .poll(async () => {
      profileId = (await call<{ profileId: string | null }>(page.request, 'profiles.find', { type: 'email', value: email })).profileId;
      return profileId;
    })
    .toBeTruthy();
  return async () => {
    const { records } = await call<{ records: { status: string; source: string }[] }>(page.request, 'consent.history', { profileId });
    return records.at(-1) ?? null;
  };
}

test.describe('hosted pages (#115)', () => {
  test('confirming with a confirmedUrl on the site lands on that page', async ({ page }) => {
    const forms = (await (await page.request.get(`${fixtures}/forms`)).json()) as { signup: string; footer: string };
    // The seeded form confirms to the site's welcome page, played by the fixtures port: a real
    // cross-origin redirect. (page.route does not reliably see a redirect's target.)
    const blocked: string[] = [];
    page.on('console', (m) => {
      if (/form-action/.test(m.text())) blocked.push(m.text());
    });

    const email = `confirm-${Date.now()}@example.net`;
    const link = await signUp(page, forms.signup, email);
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Confirm your subscription' })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, subscribe me' }).click();

    await expect(page).toHaveURL(`${fixtures}/welcome`);
    await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
    expect(blocked).toEqual([]);

    await signIn(page, PEOPLE.owner);
    const latest = await consentOf(page, email);
    await expect.poll(latest).toMatchObject({ status: 'granted', source: 'form' });
  });

  test('without a confirmedUrl, confirming shows the branded confirmed page', async ({ page }) => {
    const forms = (await (await page.request.get(`${fixtures}/forms`)).json()) as { signup: string; footer: string };
    const email = `footer-${Date.now()}@example.net`;
    const link = await signUp(page, forms.footer, email);
    await page.goto(link);
    await page.getByRole('button', { name: 'Yes, subscribe me' }).click();

    await expect(page.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();
    await expect(page).toHaveURL(link);
    await expect(page.getByRole('link', { name: 'Back to MartechSignal' })).toHaveAttribute('href', SITE);

    // The same link confirms once; clicking it again still shows the page, and GET never acts.
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Confirm your subscription' })).toBeVisible();
    await signIn(page, PEOPLE.owner);
    const latest = await consentOf(page, email);
    await expect.poll(latest).toMatchObject({ status: 'granted', source: 'form' });
  });

  test('the unsubscribe button shows the unsubscribed page', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    const { profileId } = await call<{ profileId: string }>(page.request, 'profiles.find', { type: 'email', value: 'reader1@example.net' });
    const r = await page.request.post(`${fixtures}/unsubscribe-link`, { data: { profileId } });
    const { url } = (await r.json()) as { url: string };

    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Unsubscribe' })).toBeVisible();
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByRole('heading', { name: 'Unsubscribed' })).toBeVisible();
    await expect(page).toHaveURL(url);

    const latest = await consentOf(page, 'reader1@example.net');
    await expect.poll(latest).toMatchObject({ status: 'withdrawn', source: 'unsubscribe' });
  });
});
