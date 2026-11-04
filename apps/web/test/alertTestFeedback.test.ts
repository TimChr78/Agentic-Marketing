import { expect, it } from 'vitest';
import { alertTestFeedback } from '../src/pages/insights/alertTestFeedback';

it('does not call queued alert webhooks sent', () => {
  expect(alertTestFeedback([{ status: 'queued' }])).toEqual({ success: false, message: 'Test notifications: 0 sent, 1 queued, 0 failed.' });
});
it('reports mixed outcomes separately', () => {
  expect(alertTestFeedback([{ status: 'sent' }, { status: 'queued' }, { status: 'failed' }])).toEqual({
    success: false,
    message: 'Test notifications: 1 sent, 1 queued, 1 failed.',
  });
  expect(alertTestFeedback([{ status: 'sent' }]).success).toBe(true);
});
