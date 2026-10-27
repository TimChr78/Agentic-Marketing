// Where each artifact type lives in the UI. Types without a page of their own open the generic
// artifact page, which still shows content, versions, diff and activity.

const base: Record<string, string> = {
  journey: '/build/journeys',
  broadcast: '/build/broadcasts',
  campaign: '/build/campaigns',
  form: '/build/forms',
  segment: '/build/segments',
  experience: '/build/experiences',
  prompt: '/build/prompts',
  email_template: '/design/templates',
  email_block: '/design/blocks',
};

export function artifactPath(type: string, id: string): string {
  if (type === 'brand') return '/design/brand';
  if (type === 'purposes') return '/settings/purposes';
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
};
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, ' ');
