/**
 * The consent topic a send is evaluated against (#581). The composer lets a broadcast override
 * the template's own topic, and send time uses the broadcast's value first; the approval drawer
 * must use the same precedence so its evidence describes the actual send.
 */
export function resolveConsentTopic(
  broadcastTopic: string | null | undefined,
  templateTopic: string | null | undefined,
): string | undefined {
  if (typeof broadcastTopic === 'string' && broadcastTopic.length > 0) return broadcastTopic;
  if (typeof templateTopic === 'string' && templateTopic.length > 0) return templateTopic;
  return undefined;
}
