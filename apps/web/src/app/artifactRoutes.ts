// Where each artifact type lives in the UI (#446). Canonical URLs only: legacy paths are redirects,
// never emitted by a page, a breadcrumb, a search result or a notification. Types without a page of
// their own open the generic artifact page, which still shows content, versions, diff and activity.

const base: Record<string, string> = {
  journey: '/marketing/journeys',
  broadcast: '/marketing/broadcasts',
  campaign: '/marketing/campaigns',
  form: '/audience/forms',
  segment: '/audience/segments',
  experience: '/marketing/experiences',
  prompt: '/work/agents/library',
  email_template: '/content/templates',
  email_block: '/content/templates/blocks',
};

export function artifactPath(type: string, id: string): string {
  if (type === 'brand') return '/content/brand';
  if (type === 'purposes') return '/audience/consent?tab=purposes';
  return base[type] ? `${base[type]}/${id}` : `/artifacts/${id}`;
}

export const TYPE_LABEL: Record<string, string> = {
  note: 'Note',
  journey: 'Journey',
  email_template: 'E-mail template',
  email_block: 'E-mail block',
  sms_template: 'SMS template',
  push_template: 'Push template',
  segment: 'Segment',
  experience: 'Web experience',
  prompt: 'AI prompt',
  form: 'Signup form',
  brand: 'Brand',
  broadcast: 'Broadcast',
  campaign: 'Campaign',
  tracking_plan: 'Tracking plan',
  purposes: 'Purposes',
  conversion_map: 'Conversion map',
  audience_sync: 'Audience sync',
  delivery_policy: 'Delivery policy',
  agent_mandate: 'Agent mandate',
  business_context: 'Business context',
  content_brief: 'Content brief',
  campaign_brief: 'Campaign brief',
  skill: 'Skill',
};
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, ' ');
