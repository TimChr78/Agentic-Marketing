import { expect, type Page, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';
import { primePage, settle } from './matrix.mjs';

// Phase 28 (#559) content and recipient polish acceptance. Purpose selectors name purposes
// without technical keys, the visual editor reserves its height while its chunk loads, the dark
// admin chrome follows the tokens while the recipient canvas keeps its own colours, empty lists
// name their next action, and the preview toggle, test send, block parameters and brand fields are
// unchanged. The hosted output itself is pinned by packages/artifacts/test/phase28-presentation.

type Row = { id: string; name: string };

/** The seeded artifact of a type, preferring the matrix's fixture. */
async function artifactId(page: Page, type: string, preferred: string) {
  const { artifacts } = await call<{ artifacts: Row[] }>(page.request, 'artifacts.list', { type });
  return (artifacts.find((a) => a.name === preferred) ?? artifacts[0]).id;
}

async function expectNoPageOverflow(page: Page) {
  const { scroll, client, body } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(client).toBe(390);
  expect(Math.max(scroll, body)).toBeLessThanOrEqual(client + 1);
}

/** Holds the lazily loaded GrapesJS chunk so the reserved editor slot is observable. */
async function delayVisualEditor(page: Page) {
  await page.route(
    (url) => url.pathname.includes('VisualMjml'),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    },
  );
}

const hexToRgb = (hex: string) => {
  const value = hex.trim().replace('#', '');
  return `rgb(${[0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16)).join(', ')})`;
};

test.describe('template editor at 1440', () => {
  test('the purpose and topic selectors show names alone and keep their values', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    const id = await artifactId(page, 'email_template', 'Weekly Signal #42');
    await page.goto(`/content/templates/${id}`);
    await settle(page);

    const purpose = page.getByRole('combobox', { name: 'Purpose', exact: true });
    await expect(purpose).toBeVisible();
    const purposeOptions = await purpose.locator('option').allTextContents();
    expect(purposeOptions).toContain('Marketing e-mail');
    expect(purposeOptions.join(' ')).not.toContain('marketing_email');
    expect(await purpose.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim())).toBe('Marketing e-mail');
    // The selected value is still the technical purpose the server stores.
    expect(await purpose.inputValue()).toBe('marketing_email');
    // The meaningful label is not cut off in its column.
    expect(await purpose.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    const topic = page.getByRole('combobox', { name: 'Topic (optional)', exact: true });
    const topicOptions = await topic.locator('option').allTextContents();
    expect(topicOptions.join(' ')).not.toMatch(/\((?:newsletter|product_news)\)/);

    // The preview toggle and the test send are unchanged.
    const preview = page.getByRole('button', { name: 'Preview', exact: true });
    await expect(preview).toHaveAttribute('aria-pressed', 'false');
    await preview.click();
    await expect(preview).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('iframe[title^="E-mail preview"]')).toBeVisible();
    await preview.click();
    await expect(preview).toHaveAttribute('aria-pressed', 'false');

    const sendTest = page.getByRole('button', { name: 'Send me a test', exact: true });
    await expect(sendTest).toBeVisible();
    await expect(sendTest).toHaveAttribute('title', 'Send a [Test] copy of the saved version to your own address');
  });

  test('the editor reserves its height while the visual editor loads', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    const id = await artifactId(page, 'email_template', 'Weekly Signal #42');
    await delayVisualEditor(page);
    await page.goto(`/content/templates/${id}`);

    const region = page.getByRole('status', { name: 'Loading the visual editor' });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(region).toHaveAttribute('data-skeleton-visible', 'true');
    // The editor frame itself is the reserved slot; measure it, not the tonal shape.
    const reserved = await region.locator('..').boundingBox();
    expect(reserved).not.toBeNull();
    expect(reserved!.height).toBeGreaterThanOrEqual(558);

    const editor = page.locator('.am-gjs');
    await expect(editor).toHaveAttribute('data-am-gjs-ready', 'true', { timeout: 20_000 });
    const ready = await editor.locator('..').boundingBox();
    expect(ready).not.toBeNull();
    expect(Math.abs(ready!.height - reserved!.height)).toBeLessThanOrEqual(1);
  });

  test('dark chrome follows the tokens and the inspector uses app copy', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    const id = await artifactId(page, 'email_template', 'Weekly Signal #42');
    await primePage(page, { theme: 'dark', width: 1440 });
    await page.goto(`/content/templates/${id}`);
    await settle(page);

    const tokens = await page.evaluate(() => ({
      surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
      surface2: getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim(),
    }));
    expect(tokens.surface).toBe('#191f1b');
    expect(tokens.surface2).toBe('#222a24');

    // The editor chrome is a token surface, not its own palette.
    await expect(page.locator('.am-gjs')).toHaveCSS('background-color', hexToRgb(tokens.surface2));
    // The message canvas is recipient content and keeps its own white.
    await expect(page.locator('.gjs-frame')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    // C2: the inspector names the action, not the internal tool.
    const inspector = page.getByRole('region', { name: 'Editor inspector' });
    await expect(inspector.getByText('Select an element to edit its styles')).toBeVisible();
    await expect(page.getByText(/Style Manager/)).toHaveCount(0);
  });
});

test.describe('blocks and brand fields are unchanged', () => {
  test('the empty block list names its create action and the block editor keeps every parameter', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/content/templates?tab=blocks');
    await settle(page);
    // The create action is always reachable. No block is seeded, but other specs create blocks in
    // the shared database (phase25-approval), so the empty copy is only checked when the list is
    // empty; the empty-state wording itself is covered by content-loading.test.tsx.
    await expect(page.getByRole('button', { name: 'New block' }).first()).toBeVisible();
    const rows = await page.locator('main#main table tbody tr').count();
    if (rows === 0) await expect(page.getByText('No blocks yet')).toBeVisible();

    // Every block control still exists on the detail editor.
    const created = await call<{ artifactId: string }>(page.request, 'artifacts.create', {
      type: 'email_block',
      name: `E2E block ${Date.now()}`,
      content: {
        category: 'header',
        mjml: '<mj-section><mj-column><mj-text>{{ block.title }}</mj-text></mj-column></mj-section>',
        params: [{ key: 'title', label: 'Title', type: 'text', default: 'This week' }],
      },
    });
    await page.goto(`/content/templates/blocks/${created.artifactId}`);
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Parameters' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add parameter' })).toBeVisible();
    const parameters = page.locator('section[aria-label="Parameters"]');
    for (const label of ['Key', 'Label', 'Type', 'Max length', 'Default']) {
      await expect(parameters.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByLabel('MJML fragment', { exact: true })).toBeVisible();
  });

  test('the brand fields keep their labels and the hosted preview keeps POST and its colours', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/content/brand');
    await settle(page);

    for (const label of ['Site name', 'Site address', 'Language', 'Logo alt text', 'Font', 'Corner radius']) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('group', { name: 'Confirm', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Publish a newsletter archive/ })).toBeVisible();

    await page.getByRole('tab', { name: 'Subscriber pages' }).click();
    const frame = page.frameLocator('iframe[title="Hosted confirm page preview"]');
    await expect(frame.locator('h1')).toHaveText('Confirm your subscription');
    // Recipient content keeps its published colours in the admin chrome.
    expect(await frame.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    const html = await frame.locator('html').evaluate((el) => el.outerHTML);
    expect(html).toContain('<form method="post">');
    expect(html).not.toContain('<script');
  });
});

test.describe('content at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the template list fits and a filtered empty state names the way out', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/content/templates');
    await settle(page);
    await expectNoPageOverflow(page);
    await expect(page.getByRole('button', { name: 'New template' })).toBeVisible();

    await page.getByLabel('Search templates', { exact: true }).fill('no such template');
    await expect(page.getByText('Nothing matches')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  });

  test('the template editor reserves its height and names purposes at 390', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    const id = await artifactId(page, 'email_template', 'Weekly Signal #42');
    await delayVisualEditor(page);
    await page.goto(`/content/templates/${id}`);

    const region = page.getByRole('status', { name: 'Loading the visual editor' });
    await expect(region).toBeVisible();
    const reserved = await region.locator('..').boundingBox();
    expect(reserved!.height).toBeGreaterThanOrEqual(418);

    await expect(page.locator('.am-gjs')).toHaveAttribute('data-am-gjs-ready', 'true', { timeout: 20_000 });
    const ready = await page.locator('.am-gjs').locator('..').boundingBox();
    expect(Math.abs(ready!.height - reserved!.height)).toBeLessThanOrEqual(1);
    await expectNoPageOverflow(page);

    const purpose = page.getByRole('combobox', { name: 'Purpose', exact: true });
    await expect(purpose).toBeVisible();
    expect(await (await purpose.locator('option').allTextContents()).join(' ')).not.toContain('marketing_email');
  });

  test('the asset library keeps Upload reachable and offers Clear filters when nothing matches', async ({ page }) => {
    await signIn(page, PEOPLE.owner);
    await page.goto('/content/assets');
    await settle(page);
    await expectNoPageOverflow(page);
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();

    await page.getByLabel('Search assets', { exact: true }).fill('no such asset');
    await expect(page.getByText('Nothing matches')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    await expectNoPageOverflow(page);
  });
});
