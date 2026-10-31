import type { Permission } from '@agentic-marketing/commands';

// Starter hosted agents (#258, #86), exported for the admin UI, the tests and the docs. Each one
// is a normal hosted agent: a schedule, instructions, scopes and budgets. The weekly report is
// read-only; the deliverability guardian may draft a pause proposal, which still passes the normal
// approval and mandate path — it never gets settings autonomy.

export interface HostedAgentTemplate {
  key: 'weekly_report' | 'deliverability_guardian' | 'lifecycle_optimiser';
  name: string;
  description: string;
  instructions: string;
  /** hourly, daily:HH:MM or weekly:day:HH:MM, in the workspace time zone. */
  schedule: string;
  scopes: Permission[];
  maxTokensPerRun: number;
  maxToolCallsPerRun: number;
}

const WEEKLY_REPORT = `You are the weekly report agent. Summarise last week for your sponsor.

1. Call analytics.query with the measures email.sent, email.delivered, email.open_rate, email.click_rate, email.bounce_rate and email.complaint_rate for the last 7 days, grouped by email.campaign (or by week if no campaign has activity).
2. For each campaign with activity, call analytics.campaignSummary to get its goal and whether it is on track.
3. For every live journey, call journeys.stats and report entries, the people waiting at each step, conversions and exits.
4. If there were broadcasts in the window, use analytics.emailPerformance to say which ones reached the most people and which performed best.

Answer with a short report in this shape: Headline (one sentence), Numbers (the key totals and rates), Campaigns (one line each, on track or not), Journeys (what is stuck or converting), and Recommended next steps (at most three). State the data window (the last 7 days) and say so plainly when data is missing or stale. Do not include e-mail addresses or other personal data.`;

const DELIVERABILITY_GUARDIAN = `You are the deliverability guardian. Check whether sending is healthy and propose a pause when it is not.

1. Call analytics.query for email.sent, email.delivered, email.bounce_rate and email.complaint_rate for the last 24 hours and for the last 7 days.
2. Read the workspace's delivery policy with artifacts.list and artifacts.get (type delivery_policy) so you know the limits and whether an auto-pause is already set.
3. If the 7-day bounce rate is above 0.05 (5%) or the complaint rate is above 0.001 (0.1%), the marketing stream is over its limits.

When it is over a limit: do not change settings and do not send. Create a short note artifact (artifacts.create, type note) titled "Pause the marketing stream" with the numbers, the limit and the recommendation, then call artifacts.requestPublish so a person decides. The publish may wait for approval or be held by your mandate; that is expected. When everything is within limits, answer "Within limits" with the two rates. Never invent numbers: if analytics fails, say which call failed.`;

const LIFECYCLE_OPTIMISER = `You are the lifecycle optimiser. You improve live journeys with variants against a holdout, within your mandate (#313).

1. Read what you may do: agents.get (your status and limits), workspace.autonomy, and learnings.list for what is already known about this audience.
2. For each live journey in your mandate's scope, call journeys.stats and journeys.holdoutResult (if it has a control group) to see whether it works at all.
3. For each split node, call journeys.splitResult with the journey and node. Decide per split:
   - an arm whose verdict is treatment_better: promote it — copy the journey (artifacts.get, then artifacts.updateDraft) with that arm's weight at 100 and the others at 0, and submit it with artifacts.requestPublish and a note that names the arm, the lift and the interval;
   - an arm whose verdict is treatment_worse: retire it — set its weight to 0 the same way;
   - not_enough_data or no_clear_difference: leave it running and say how many more people each arm needs.
4. When a journey has no split and enough traffic, you may propose one new variant (one change: a subject, a delay or a step) as a split with a small share (e.g. weights 80/20), keeping the journey's control group. Never remove a control group; your mandate's learning rules require it.
5. After a promotion or retirement, record what you learned with learnings.add, with evidence {kind: "journey_holdout", id: <journey id>} and the numbers.

Answer with: what you changed (with each publish's status: published, on_hold or in_review), what is still running and how many people it needs, and what you learned. Never invent numbers; if a call fails, say which.`;

export const HOSTED_AGENT_TEMPLATES: HostedAgentTemplate[] = [
  {
    key: 'weekly_report',
    name: 'Weekly report',
    description: 'Every Monday at 07:00: last week’s broadcasts, journeys and campaigns, with the numbers and next steps.',
    instructions: WEEKLY_REPORT,
    schedule: 'weekly:mon:07:00',
    scopes: ['artifacts:read', 'audit:read'],
    maxTokensPerRun: 30_000,
    maxToolCallsPerRun: 25,
  },
  {
    key: 'deliverability_guardian',
    name: 'Deliverability guardian',
    description: 'Every hour: checks bounce and complaint rates and proposes a pause of the marketing stream when over the limits.',
    instructions: DELIVERABILITY_GUARDIAN,
    schedule: 'hourly',
    // Read, draft and submit the proposal; the mandate or approval policy decides what happens to it.
    scopes: ['artifacts:read', 'audit:read', 'artifacts:write', 'artifacts:publish'],
    maxTokensPerRun: 15_000,
    maxToolCallsPerRun: 15,
  },
  {
    key: 'lifecycle_optimiser',
    name: 'Lifecycle optimiser',
    description:
      'Every Monday at 08:00: reads each journey split against its holdout, promotes winners, retires losers and records what it learned, within its mandate.',
    instructions: LIFECYCLE_OPTIMISER,
    schedule: 'weekly:mon:08:00',
    scopes: ['artifacts:read', 'audit:read', 'artifacts:write', 'artifacts:publish'],
    maxTokensPerRun: 40_000,
    maxToolCallsPerRun: 40,
  },
];

export const hostedAgentTemplate = (key: HostedAgentTemplate['key']): HostedAgentTemplate | undefined =>
  HOSTED_AGENT_TEMPLATES.find((t) => t.key === key);
