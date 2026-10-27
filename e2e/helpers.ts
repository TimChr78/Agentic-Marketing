import { type APIRequestContext, expect, type Page } from '@playwright/test';

/** Where the seeded server runs (see playwright.config.ts). */
export const BASE = process.env.E2E_BASE ?? `http://localhost:${process.env.E2E_PORT ?? 3100}`;
export const PASSWORD = 'correct-horse-battery-staple';
export const PEOPLE = { owner: 'alex@example.com', builder: 'sam@example.com', approver: 'jo@example.com', viewer: 'vic@example.com' };

/** Signs in through the API (sets the session cookie for the page's context). */
export async function signIn(page: Page, email: string) {
  const r = await page.request.post('/api/auth/sign-in/email', { data: { email, password: PASSWORD }, headers: { origin: BASE } });
  expect(r.ok(), `sign-in for ${email}: ${await r.text()}`).toBeTruthy();
}

/** Calls a command as the signed-in person. */
export async function call<T = any>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const r = await request.post(`/v1/${name}`, { data: input, headers: { 'content-type': 'application/json' } });
  const body = await r.json();
  expect(r.ok(), `${name}: ${JSON.stringify(body)}`).toBeTruthy();
  return body as T;
}
