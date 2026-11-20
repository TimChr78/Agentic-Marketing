/**
 * The point after which a delivery attempt may have reached its provider (#1054).
 *
 * A handler sets `providerCalled` immediately before the first call that can hand the message to a
 * provider. The delivery worker uses it when an unexpected error escapes a handler: before this
 * point the message may safely go back to `queued`, because no one can have received it; after it,
 * a retry could duplicate a send, so the message is failed conservatively instead.
 */
export interface DeliveryAttempt {
  providerCalled: boolean;
}
