import { describe, expect, it } from 'vitest';
import { METRIC_CATALOG } from '../../../packages/analytics/src/registry';
import {
  ACTION_CLASS_LABEL,
  AGENT_DECISION_LABEL,
  ANALYTICS_DIMENSIONS,
  ANALYTICS_MEASURES,
  ARTIFACT_TYPE_LABEL,
  actionClassLabel,
  agentDecisionLabel,
  artifactTypeLabel,
  dimensionLabel,
  eventTypeLabel,
  measureLabel,
  measureUnit,
  metricLabel,
  purposeLabel,
} from '../src/lib/labels';

// The catalogue is read from the compiler's own source, so adding a measure without its label
// fails here instead of leaking a raw key into the Analytics picker.
describe('label registry coverage (#437)', () => {
  it('has a plain name and the catalogue unit for every analytics measure', () => {
    for (const measure of METRIC_CATALOG.measures) {
      const entry = ANALYTICS_MEASURES[measure.id];
      expect(entry, `missing label for measure ${measure.id}`).toBeDefined();
      expect(entry.label.trim(), `empty label for ${measure.id}`).not.toBe('');
      expect(entry.label, `${measure.id} still reads as its raw key`).not.toBe(measure.id);
      expect(entry.description.trim(), `empty description for ${measure.id}`).not.toBe('');
      expect(measureUnit(measure.id), `unit drift for ${measure.id}`).toBe(measure.unit);
    }
  });

  it('has a plain name for every analytics dimension', () => {
    for (const dimension of METRIC_CATALOG.dimensions) {
      const entry = ANALYTICS_DIMENSIONS[dimension.id];
      expect(entry, `missing label for dimension ${dimension.id}`).toBeDefined();
      expect(entry.label.trim(), `empty label for ${dimension.id}`).not.toBe('');
      expect(entry.label, `${dimension.id} still reads as its raw key`).not.toBe(dimension.id);
      expect(entry.description.trim(), `empty description for ${dimension.id}`).not.toBe('');
    }
  });

  it('does not fall back for a catalogue key', () => {
    for (const measure of METRIC_CATALOG.measures) expect(measureLabel(measure.id)).toBe(ANALYTICS_MEASURES[measure.id].label);
    for (const dimension of METRIC_CATALOG.dimensions) expect(dimensionLabel(dimension.id)).toBe(ANALYTICS_DIMENSIONS[dimension.id].label);
    expect(metricLabel('email.click_rate')).toBe('Click rate');
    expect(metricLabel('day')).toBe('Day');
  });

  it('covers agent action classes and decisions', () => {
    for (const actionClass of [
      'read',
      'draft',
      'content.publish',
      'audience.publish',
      'send.broadcast',
      'send.direct',
      'journey.live',
      'experience.live',
      'spend',
      'data.write',
      'settings',
      'destructive',
    ]) {
      expect(ACTION_CLASS_LABEL[actionClass], `missing action class ${actionClass}`).toBeTruthy();
      expect(actionClassLabel(actionClass)).not.toBe(actionClass);
    }
    for (const decision of ['allow', 'hold', 'ask', 'deny']) {
      expect(AGENT_DECISION_LABEL[decision], `missing decision ${decision}`).toBeTruthy();
      expect(agentDecisionLabel(decision)).not.toBe(decision);
    }
  });

  it('covers artifact types, event types and purposes', () => {
    for (const type of [
      'journey',
      'broadcast',
      'email_template',
      'email_block',
      'sms_template',
      'push_template',
      'segment',
      'experience',
      'prompt',
      'form',
      'brand',
      'campaign',
      'agent_mandate',
      'purposes',
      'conversion_map',
    ]) {
      expect(ARTIFACT_TYPE_LABEL[type], `missing artifact type ${type}`).toBeTruthy();
      expect(artifactTypeLabel(type)).not.toBe(type);
    }
    for (const type of [
      'queued',
      'sent',
      'suppressed',
      'failed',
      'delivered',
      'bounced',
      'deferred',
      'complained',
      'opened',
      'clicked',
      'unsubscribed',
      'entered',
      'step',
      'waiting',
      'resumed',
      'converted',
      'completed',
      'exited',
      'holdout_assigned',
      'track',
      'page',
      'screen',
      'identify',
      'group',
      'alias',
    ]) {
      expect(eventTypeLabel(type), `missing event type ${type}`).not.toBe(type);
    }
    expect(purposeLabel('marketing_email')).toBe('Marketing e-mail');
    expect(purposeLabel('marketing_email', [{ key: 'marketing_email', name: 'Weekly signal' }])).toBe('Weekly signal');
    expect(purposeLabel('custom_purpose')).toBe('Unavailable purpose');
  });
});
