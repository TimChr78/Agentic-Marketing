// Agent action-class and decision words (#437). Kept separate from the analytics registry so the
// application shell can read them without loading measure and dimension labels on every route.

export const ACTION_CLASS_LABEL: Record<string, string> = {
  read: 'Reading',
  draft: 'Drafting',
  'content.publish': 'Content publishing',
  'audience.publish': 'Audience publishing',
  'send.broadcast': 'Broadcast sends',
  'send.direct': 'Direct sends',
  'journey.live': 'Live journeys',
  'experience.live': 'Live experiences',
  spend: 'Spend',
  'data.write': 'Data writes',
  settings: 'Settings changes',
  destructive: 'Destructive actions',
};

const humanise = (key: string) =>
  key
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSms\b/g, 'SMS');

export function actionClassLabel(actionClass: string): string {
  return ACTION_CLASS_LABEL[actionClass] ?? humanise(actionClass);
}

/** A policy decision: allowed ran, hold waited for a veto, ask waited for a person, deny was refused. */
export const AGENT_DECISION_LABEL: Record<string, string> = {
  allow: 'Allowed',
  hold: 'Held for a veto',
  ask: 'Waited for a person',
  deny: 'Refused',
};

export function agentDecisionLabel(decision: string): string {
  return AGENT_DECISION_LABEL[decision] ?? humanise(decision);
}
