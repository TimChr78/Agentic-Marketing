import { ApiError } from '../../../app/api';
import type { DemoRead } from '../integration/demo';
import {
  DEMO_AGENTS,
  DEMO_AI_CALLS,
  DEMO_AI_PROVIDERS,
  DEMO_AI_REVIEWS,
  DEMO_AI_USAGE,
  DEMO_ALERTS,
  DEMO_ASSETS,
  DEMO_AUDIT,
  DEMO_AUTONOMY,
  DEMO_BLOCK_USAGE,
  DEMO_BROADCASTS,
  DEMO_CAMPAIGNS_OF,
  DEMO_CONNECTIONS,
  DEMO_CONNECTORS,
  DEMO_EMAIL_PROVIDERS,
  DEMO_INVITATIONS,
  DEMO_MEMBER_ROWS,
  DEMO_METRICS,
  DEMO_PROPOSALS,
  DEMO_PURPOSES,
  DEMO_PUSH_PROVIDERS,
  DEMO_RECIPE,
  DEMO_RECIPES,
  DEMO_RUN_FAILURES,
  DEMO_SCIM,
  DEMO_SECRETS,
  DEMO_SENDING_DOMAINS,
  DEMO_SMS_PROVIDERS,
  DEMO_SOURCES,
  DEMO_SSO,
  DEMO_STATUS,
  DEMO_TOKENS,
  DEMO_TOPICS,
  DEMO_WEBHOOKS,
  demoAlertHistory,
  demoAnalyticsQuery,
  demoApprovalById,
  demoArtifactById,
  demoArtifactDiff,
  demoArtifactHistory,
  demoConsentHistory,
  demoConsentSummary,
  demoJourneyStats,
  demoMessages,
  demoProfile,
  demoProfileEvents,
  demoProfileRowsPage,
  demoRecipePreview,
  demoSegmentsOfProfile,
  demoTemplateCheck,
  demoTemplatePreview,
  demoTopics,
} from './fixtures';

// The reads each demo destination exercises (#530), keyed by the exact command name the page calls.
// They answer from `./fixtures.ts` only; nothing here touches the network, storage or a clock. The
// guard in `demoReads()` still refuses every mutation and names anything not listed here unavailable.

const notFound = (what: string) => new ApiError(404, 'not_found', `${what} is not part of the demo sample.`);

export function demoDestinationReads(): Record<string, DemoRead<any>> {
  return {
    // Artifacts: lists come from #524's projection; detail, versions and diff are added here.
    'artifacts.get': (input: { artifactId: string }) => demoArtifactById(input.artifactId),
    'artifacts.history': (input: { artifactId: string }) => demoArtifactHistory(input.artifactId),
    'artifacts.diff': (input: { artifactId: string }) => demoArtifactDiff(input.artifactId),

    // Approvals: the Open drawer reads one request with its consequence payload.
    'approvals.get': (input: { approvalId: string }) => demoApprovalById(input.approvalId),
    'workspace.proposals': () => DEMO_PROPOSALS,

    // Home and the shared operational panels.
    'system.status': () => DEMO_STATUS,
    'agents.list': () => DEMO_AGENTS,
    'agents.runFailures': () => DEMO_RUN_FAILURES,
    'alerts.list': () => DEMO_ALERTS,
    'alerts.history': (input: { ruleId?: string }) => demoAlertHistory(input.ruleId),
    'broadcasts.list': () => DEMO_BROADCASTS,
    'sendingDomains.list': () => DEMO_SENDING_DOMAINS,
    'workspace.autonomy': () => DEMO_AUTONOMY,

    // People: the list, one person and the three loaded history lanes.
    'profiles.list': (input: { limit?: number; before?: string; beforeId?: string }) => demoProfileRowsPage(input),
    'profiles.get': (input: { profileId: string }) => demoProfile(input.profileId),
    'profiles.find': (input: { type: string; value: string }) => ({
      profileId:
        input.type === 'email' ? (demoProfileRowsPage({ limit: 200 }).profiles.find((row) => row.email === input.value)?.id ?? null) : null,
    }),
    'profiles.events': (input: { profileId: string }) => demoProfileEvents(input.profileId),
    'messages.list': (input: { profileId?: string }) => demoMessages(input.profileId),
    'messages.stats': () => ({
      counts: { queued: 0, sending: 0, sent: 42, suppressed: 3, failed: 1, delivered: 41, bounced: 1, complained: 0 },
      rates: { delivered: 0.976, bounced: 0.024, complained: 0, clicked: 0.34, unsubscribed: 0.003 },
    }),
    'consent.history': (input: { profileId: string }) => demoConsentHistory(input.profileId),
    'consent.summary': () => demoConsentSummary(),
    'purposes.list': () => DEMO_PURPOSES,
    'topics.preferences': (input: { profileId: string }) => demoTopics(input.profileId),
    'segments.ofProfile': (input: { profileId: string }) => demoSegmentsOfProfile(input.profileId),
    'segments.preview': () => ({ count: 486, sample: [], tookMs: 1 }),

    // Journeys: the report and builder read the shared artifact detail plus these stats.
    'journeys.stats': (input: { journeyId: string }) => demoJourneyStats(input.journeyId),

    // Content and templates.
    'templates.preview': () => demoTemplatePreview(),
    'templates.check': () => demoTemplateCheck(),
    'blocks.usage': () => DEMO_BLOCK_USAGE,
    'assets.list': () => DEMO_ASSETS,
    'assets.get': () => {
      throw notFound('This asset');
    },
    'recipes.list': () => DEMO_RECIPES,
    'recipes.get': () => DEMO_RECIPE,
    'recipes.preview': () => demoRecipePreview(),
    'content.topics.list': () => DEMO_TOPICS,

    // Analytics and the AI usage tab.
    'analytics.query': (input: Parameters<typeof demoAnalyticsQuery>[0]) => demoAnalyticsQuery(input),
    'analytics.metrics.list': () => DEMO_METRICS,
    'analytics.journeyFunnel': (input: { journeyId: string }) => ({
      journeyId: input.journeyId,
      entered: 120,
      goalReached: 45,
      completed: 45,
      exited: 20,
      steps: [
        { step: 'Confirmed subscription', reached: 120, dropOff: 0, dropOffRate: 0 },
        { step: 'Welcome e-mail', reached: 120, dropOff: 0, dropOffRate: 0 },
        { step: 'Wait two days', reached: 86, dropOff: 34, dropOffRate: 34 / 120 },
        { step: 'Opened the welcome?', reached: 52, dropOff: 34, dropOffRate: 34 / 86 },
      ],
      meta: { timeZone: 'UTC', currency: 'DKK', from: '', to: '', freshness: null, suppressed: 0, k: 5, notes: [] },
    }),
    'analytics.campaignSummary': (input: { campaignId: string }) => ({
      campaignId: input.campaignId,
      name: 'Signal autumn 2026',
      state: 'published',
      goal: { kind: 'engagement', event: 'Email Clicked', target: 500, attributionDays: 7 },
      readiness: { published: true, membersPublished: true, sendingMembers: 1, publishedSendingMembers: 1, sendingMembersScheduled: false },
      meta: { timeZone: 'UTC', currency: 'DKK', from: '', to: '', freshness: null, suppressed: 0, k: 5, notes: [] },
    }),
    'ai.usage': () => DEMO_AI_USAGE,
    'ai.calls': () => DEMO_AI_CALLS,
    'ai.reviews': () => DEMO_AI_REVIEWS,

    // Approvals consequence previews and activity.
    'broadcasts.preview': () => ({
      audience: 486,
      checked: 486,
      wouldSend: 486,
      wouldSkip: {},
      sendAt: null,
      sendWindow: null,
      subjectTest: null,
    }),
    'broadcasts.status': () => {
      throw notFound('Live sending status');
    },
    'campaigns.of': () => DEMO_CAMPAIGNS_OF,
    'campaigns.holdoutResult': () => {
      throw notFound('Campaign holdout results');
    },
    'experiences.results': () => ({
      goal: 'Newsletter Signup',
      control: 'control',
      variants: [
        {
          variant: 'control',
          exposed: 1240,
          converted: 62,
          rate: 0.05,
          lift: null,
          pValue: null,
          ci95: null,
          sequentialP: null,
          probBeatControl: null,
          probBest: 0.22,
          expectedLoss: 0.004,
        },
        {
          variant: 'test',
          exposed: 1228,
          converted: 88,
          rate: 0.0717,
          lift: 0.0217,
          pValue: 0.03,
          ci95: [0.004, 0.039],
          sequentialP: 0.028,
          probBeatControl: 0.97,
          probBest: 0.78,
          expectedLoss: 0.001,
        },
      ],
      method: 'sequential',
      recommendation: 'The test is ahead; keep it running until the planned sample is reached.',
      note: 'Sample data only. No live experiment is running in the demo.',
    }),
    'audit.list': () => DEMO_AUDIT,

    // Settings and integrations — existing pages render their ordinary empty/read-only states.
    'members.list': () => DEMO_MEMBER_ROWS,
    'invitations.list': () => DEMO_INVITATIONS,
    'webhooks.list': () => DEMO_WEBHOOKS,
    'apiTokens.list': () => DEMO_TOKENS,
    'secrets.list': () => DEMO_SECRETS,
    'emailProviders.list': () => DEMO_EMAIL_PROVIDERS,
    'smsProviders.list': () => DEMO_SMS_PROVIDERS,
    'pushProviders.list': () => DEMO_PUSH_PROVIDERS,
    'aiProviders.list': () => DEMO_AI_PROVIDERS,
    'sources.list': () => DEMO_SOURCES,
    'connections.list': () => DEMO_CONNECTIONS,
    'connectors.list': () => DEMO_CONNECTORS,
    'sso.list': () => DEMO_SSO,
    'scim.status': () => DEMO_SCIM,
  };
}

/** Kept next to the reads so the demo's own tests can assert the projection is complete. */
export const DEMO_READ_NAMES = [
  'workspace.get',
  'workspace.memberships',
  'approvals.list',
  'artifacts.list',
  ...Object.keys(demoDestinationReads()),
] as const;
