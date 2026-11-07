import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { call, PEOPLE, signIn } from './helpers';

// Phase 25, #498: the approval drawer opens with a consequence summary, then the exact reviewed
// message, then the changes. These tests run on the seeded server and create their own pending
// requests, so they do not depend on which spec ran before them.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ADMIN = 'all_publishes';

async function withApprovalPolicy<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  await call(page.request, 'workspace.setApprovalPolicy', { policy: ADMIN });
  try {
    return await fn();
  } finally {
    await call(page.request, 'workspace.setApprovalPolicy', { policy: 'agent_changes' });
  }
}

async function seedRefs(page: Page) {
  const templates = await call<{ artifacts: { id: string; name: string }[] }>(page.request, 'artifacts.list', {
    type: 'email_template',
    limit: 200,
  });
  const segments = await call<{ artifacts: { id: string; name: string }[] }>(page.request, 'artifacts.list', {
    type: 'segment',
    limit: 200,
  });
  const template = templates.artifacts.find((a) => a.name === 'Weekly Signal #42') ?? templates.artifacts[0];
  const segment = segments.artifacts.find((a) => a.name === 'Engaged readers') ?? segments.artifacts[0];
  expect(template, 'the seed has a published e-mail template').toBeTruthy();
  expect(segment, 'the seed has a segment').toBeTruthy();
  return { template: template!, segment: segment! };
}

async function requestBroadcast(page: Page, name: string, description = 'A broadcast for the review drawer.') {
  return withApprovalPolicy(page, async () => {
    const { template, segment } = await seedRefs(page);
    const created = await call<{ artifactId: string }>(page.request, 'artifacts.create', {
      type: 'broadcast',
      name,
      content: {
        template: template.id,
        segment: segment.id,
        description,
        sendAt: '2026-12-01T09:00:00Z',
        sendWindow: { start: '09:00', end: '17:00', days: ['mon', 'tue'], maxDelay: 'P1D' },
        subjectTest: {
          subjects: ['The consequence first', 'What publishes, to whom'],
          samplePercent: 20,
          metric: 'click',
          decideAfter: 'PT4H',
        },
        archive: { publish: true, slug: 'review-consequence', summary: 'The review drawer issue.' },
      },
    });
    const request = await call<{ approvalId: string; version: number }>(page.request, 'artifacts.requestPublish', {
      artifactId: created.artifactId,
      note: 'Review this broadcast before it goes to engaged readers.',
    });
    return { ...request, artifactId: created.artifactId };
  });
}

async function axeDrawer(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).options({ iframes: false }).exclude('iframe').analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.help}`),
    'the approval drawer has no axe violations',
  ).toEqual([]);
}

test('the review opens with consequences, then the exact message, then the changes', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  const request = await requestBroadcast(page, 'Review broadcast: consequence');

  await signIn(page, PEOPLE.approver);
  await page.goto(`/approvals/${request.approvalId}`);
  const drawer = page.getByRole('dialog', { name: 'Review broadcast: consequence' });
  await expect(drawer).toBeVisible();

  // Heading metadata separates the reviewed Saved vN from the Published pointer.
  await expect(drawer).toContainText('Broadcast · Reviewing Saved v1 · Nothing live yet');
  await expect(drawer.getByRole('heading', { name: 'If approved' })).toBeVisible();
  await expect(drawer).toContainText('Publishes');
  await expect(drawer).toContainText('Review broadcast: consequence · Broadcast · Saved v1');
  await expect(drawer.getByText('Nothing live yet').first()).toBeVisible();

  // When, dependencies and the exact audience check.
  await expect(drawer.getByText('When', { exact: true })).toBeVisible();
  await expect(drawer).toContainText(/Dec 1, 2026/);
  await expect(drawer).toContainText('Weekly Signal #42');
  await expect(drawer).toContainText('Engaged readers');
  await expect(drawer.getByText('Eligible in current check')).toBeVisible();
  await expect(drawer.getByText(/\d[\d,]* in current check|No eligible recipients in this check|No members checked/)).toBeVisible({
    timeout: 30_000,
  });

  // Evidence and consent are separate sections; the seeded log adapter and an unchecked DKIM
  // selector must be visible as such, never as a green readiness promise.
  await expect(drawer.getByRole('heading', { name: 'Consent' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Evidence' })).toBeVisible();
  await expect(drawer).toContainText('Purpose configured · Marketing e-mail · consent');
  await expect(drawer).toContainText('Log adapter — no external delivery');
  await expect(drawer.getByText(/DKIM not checked — selectors required|No sending domain for marketing mail/).first()).toBeVisible();
  await expect(drawer).not.toContainText('Audience consented');

  // The message is labelled as the exact saved version under review.
  await expect(drawer.locator('[data-preview-source="saved"]').first()).toContainText('Saved v1');
  await expect(drawer.locator('[data-preview-source="saved"]').first()).toContainText('Under review');
  await expect(drawer.frameLocator('iframe[title^="E-mail preview"]').getByText(/This week: why last-click attribution/)).toBeVisible({
    timeout: 20_000,
  });

  // Review / Content / History replaces Preview / Changes; the diff is initially open.
  await expect(drawer.getByRole('tab', { name: 'Review' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Content' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'History' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Preview' })).toHaveCount(0);
  await expect(drawer.getByRole('tab', { name: 'Changes' })).toHaveCount(0);
  await expect(drawer.getByRole('heading', { name: /Changes · \d+/ })).toBeVisible();
  const diffDisclosure = drawer.locator('details');
  await expect(diffDisclosure).toHaveAttribute('open', '');

  // Axe on the open drawer, both themes at 1440 and light at 390. Preview frames are sandboxed
  // renders of what subscribers see, not admin UI, and are excluded as in the route axe suite.
  await axeDrawer(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    localStorage.setItem('am.theme', 'dark');
  });
  await axeDrawer(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    localStorage.setItem('am.theme', 'light');
  });
  await axeDrawer(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Opening the rendered Review marks the exact version viewed; the row becomes selectable.
  await page.getByRole('button', { name: 'Close' }).click();
  const row = page.getByRole('row', { name: /Review broadcast: consequence/ });
  await expect(row).toContainText('Viewed');
  await expect(row.getByRole('checkbox')).toBeEnabled();

  await row.getByRole('link', { name: 'Review broadcast: consequence' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve and publish' }).click();
  await expect(page.getByText('Approved “Review broadcast: consequence”')).toBeVisible();
  const after = await call<{ publishedVersion: number | null }>(page.request, 'artifacts.get', { artifactId: request.artifactId });
  expect(after.publishedVersion).toBe(1);
});

test('a newer draft is shown, but it does not disable approval of the exact version', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  const request = await requestBroadcast(page, 'Review broadcast: stale');

  // A later draft arrives while the exact version is waiting for review.
  await signIn(page, PEOPLE.builder);
  const artifact = await call<{ version: { content: Record<string, unknown> } }>(page.request, 'artifacts.get', {
    artifactId: request.artifactId,
  });
  const updated = await call<{ version: number }>(page.request, 'artifacts.updateDraft', {
    artifactId: request.artifactId,
    content: { ...artifact.version.content, description: 'A later draft with a different description.' },
  });
  expect(updated.version).toBe(2);

  await signIn(page, PEOPLE.approver);
  await page.goto(`/approvals/${request.approvalId}`);
  const drawer = page.getByRole('dialog', { name: 'Review broadcast: stale' });
  await expect(drawer.getByText('A newer draft (v2) exists')).toBeVisible();
  await expect(drawer).toContainText('Approving publishes v1, the one shown here. The newer draft stays a draft.');
  const approve = drawer.getByRole('button', { name: 'Approve and publish' });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText('Approved “Review broadcast: stale”')).toBeVisible();

  const after = await call<{ publishedVersion: number | null; latestVersion: number }>(page.request, 'artifacts.get', {
    artifactId: request.artifactId,
  });
  expect(after.publishedVersion).toBe(1);
  expect(after.latestVersion).toBe(2);
});

test('a bundle shows every member first, then the selected member’s detail, and rejects all at once', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  const { segment } = await seedRefs(page);
  const bundle = await withApprovalPolicy(page, async () => {
    const tpl = await call<{ artifactId: string }>(page.request, 'artifacts.create', {
      type: 'email_template',
      name: 'Review bundle template',
      content: {
        purpose: 'marketing_email',
        subject: 'Review bundle: one message, one review',
        preheader: 'Approved together',
        mjml:
          '<mjml><mj-body><mj-section><mj-column><mj-text>Bundled together.</mj-text>' +
          '<mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
      },
    });
    const send = await call<{ artifactId: string }>(page.request, 'artifacts.create', {
      type: 'broadcast',
      name: 'Review bundle send',
      content: { template: tpl.artifactId, segment: segment.id, sendAt: '2026-12-02T09:00:00Z' },
    });
    return call<{ members: { approvalId: string; artifactId: string; type: string; name: string }[] }>(
      page.request,
      'artifacts.requestPublishBundle',
      { artifactIds: [send.artifactId, tpl.artifactId], note: 'A template and its send, for one review.' },
    );
  });
  const broadcastMember = bundle.members.find((m) => m.type === 'broadcast') ?? bundle.members[bundle.members.length - 1]!;

  await signIn(page, PEOPLE.approver);
  await page.goto(`/approvals/${broadcastMember.approvalId}`);
  const drawer = page.getByRole('dialog', { name: 'Review bundle send' });
  await expect(drawer.getByRole('heading', { name: 'Reviewed together' })).toBeVisible();
  await expect(drawer).toContainText('Publishes 2 changes together');
  await expect(drawer).toContainText('Approving publishes all of them, in this order, in one step; rejecting rejects all.');
  await expect(drawer).toContainText('Audience checks use current membership; bundled changes are not simulated.');
  const bundleRegion = drawer.getByRole('region', { name: 'Reviewed together' });
  await expect(bundleRegion.getByRole('link', { name: 'Review bundle template' })).toBeVisible();
  await expect(bundleRegion.getByRole('link', { name: 'Review bundle send' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Approve all 2 and publish' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Reject all' })).toBeVisible();
  // The member versions and live/stale state are on the member rows.
  await expect(bundleRegion).toContainText('Saved v1');
  await expect(bundleRegion).toContainText('Nothing live yet');

  // The overall summary stays first; selecting the template shows its own detail after it.
  await bundleRegion.getByRole('link', { name: 'Review bundle template' }).click();
  const templateDrawer = page.getByRole('dialog', { name: 'Review bundle template' });
  await expect(templateDrawer.getByRole('heading', { name: 'Reviewed together' })).toBeVisible();
  await expect(templateDrawer).toContainText('E-mail template');
  await expect(templateDrawer.getByRole('heading', { name: 'If approved' })).toBeVisible();

  // Reject all requires a nonempty reason and rejects every member.
  await page.goto(`/approvals/${broadcastMember.approvalId}`);
  const again = page.getByRole('dialog', { name: 'Review bundle send' });
  await again.getByRole('button', { name: 'Reject all' }).click();
  await expect(again.getByLabel('Why are you rejecting it?')).toBeFocused();
  await again.getByRole('button', { name: 'Reject all 2 with reason' }).click();
  await expect(again).toContainText('Say what to change');
  await again.getByRole('button', { name: 'Cancel' }).click();
  await again.getByRole('button', { name: 'Reject all' }).click();
  await again.getByLabel('Why are you rejecting it?').fill('The offer is not ready yet.');
  await again.getByRole('button', { name: 'Reject all 2 with reason' }).click();
  await expect(page.getByText(/Rejected 2 changes/)).toBeVisible();
  const rejected = await call<{ approvals: { artifactName: string }[] }>(page.request, 'approvals.list', {
    status: 'rejected',
    limit: 200,
  });
  const names = rejected.approvals.map((a) => a.artifactName);
  expect(names).toContain('Review bundle send');
  expect(names).toContain('Review bundle template');
});

test('a workspace proposal says what changes immediately and explains the time zone', async ({ page }) => {
  await signIn(page, PEOPLE.builder);
  await call(page.request, 'workspace.proposeUpdate', {
    timeZone: 'Europe/Berlin',
    note: 'The editorial desk moved to Berlin; display dates there.',
  });
  await signIn(page, PEOPLE.owner);
  await page.goto('/approvals');
  const card = page.getByRole('region', { name: 'Workspace settings' });
  await expect(card).toContainText('Applies workspace settings immediately on approval.');
  await expect(card).toContainText('Time zone:');
  await expect(card).toContainText('Europe/Berlin');
  await expect(card).toContainText('Changes display time zone; stored send instants stay the same.');
  await expect(card).toContainText('The editorial desk moved to Berlin');
  // No version, audience or dependency language for a workspace setting.
  await expect(card).not.toContainText('Saved v');
  await expect(card).not.toContainText('Dependencies');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved the workspace settings change')).toBeVisible();
  const ws = await call<{ timeZone: string }>(page.request, 'workspace.get', {});
  expect(ws.timeZone).toBe('Europe/Berlin');
  await call(page.request, 'workspace.update', { timeZone: 'UTC' });
});

test('a restricted reader sees the review without an audience count or approval actions', async ({ page }) => {
  await signIn(page, PEOPLE.owner);
  const request = await withApprovalPolicy(page, async () => {
    const created = await call<{ artifactId: string }>(page.request, 'artifacts.create', {
      type: 'segment',
      name: 'Review restricted segment',
      content: { description: 'A segment the viewer may inspect but not size.', condition: { consent: 'marketing_email' } },
    });
    return call<{ approvalId: string }>(page.request, 'artifacts.requestPublish', {
      artifactId: created.artifactId,
      note: 'Please review the definition.',
    });
  });

  await signIn(page, PEOPLE.viewer);
  await page.goto(`/approvals/${request.approvalId}`);
  const drawer = page.getByRole('dialog', { name: 'Review restricted segment' });
  await expect(drawer.getByRole('heading', { name: 'If approved' })).toBeVisible();
  await expect(drawer.getByText('Estimated members now')).toBeVisible();
  await expect(drawer.getByText('Membership count restricted')).toBeVisible();
  await expect(drawer).toContainText('Your role cannot read profiles');
  await expect(drawer).toContainText('Your role can review changes but not approve them.');
  await expect(drawer.getByRole('button', { name: 'Approve and publish' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  // No count is invented from the restricted read.
  await expect(drawer).not.toContainText(/\d+ people/);

  // Leave the fixture decided rather than pending for later specs.
  await signIn(page, PEOPLE.owner);
  await call(page.request, 'approvals.reject', { approvalId: request.approvalId, note: 'Cleaning up the review fixture.' });
});
