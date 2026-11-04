/** Queue acceptance is distinct from confirmed delivery in the alert test response. */
export function alertTestFeedback(notifications: readonly Record<string, unknown>[]) {
  const sent = notifications.filter((n) => n.status === 'sent').length;
  const queued = notifications.filter((n) => n.status === 'queued').length;
  const failed = notifications.length - sent - queued;
  return {
    success: sent === notifications.length && sent > 0,
    message: `Test notifications: ${sent} sent, ${queued} queued, ${failed} failed.`,
  };
}
