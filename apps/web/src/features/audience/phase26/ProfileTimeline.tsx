import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { Alert, Button, EmptyState, formatDateTime, LoadingBlock, Tag } from '../../../ui';
import { buildTimeline, latestLoadedLabel, type Purpose, timelineCounts } from './model';
import type { ProfileTimelineState } from './peopleData';

// Loaded history, not a complete chronology. Each lane keeps its own cursor and its own failure,
// and the caption names exactly what each source covers.

export function ProfileTimeline({ timeline, purposes }: { timeline: ProfileTimelineState; purposes: readonly Purpose[] | undefined }) {
  const items = useMemo(
    () => buildTimeline({ events: timeline.events, messages: timeline.messages, consent: timeline.consent, purposes }),
    [timeline.events, timeline.messages, timeline.consent, purposes],
  );
  const counts = timelineCounts(timeline.events.length, timeline.messages.length, timeline.consent.length);
  const latest = latestLoadedLabel(items);
  const anyError = Boolean(timeline.eventsError || timeline.messagesError || timeline.consentError);

  if (timeline.loading) {
    return (
      <div className="rounded-lg border border-line bg-surface" aria-busy="true">
        <LoadingBlock lines={7} label="Loading profile history" />
      </div>
    );
  }

  return (
    <section aria-labelledby="profile-history-heading" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="profile-history-heading" className="text-[16px] leading-6 font-semibold">
          Loaded history
        </h2>
        <p className="text-[12px] leading-[18px] text-muted">{counts}</p>
      </div>
      <p className="text-[12px] leading-[18px] text-muted">
        Events and consent include merged identities; messages cover the current profile only.
      </p>
      <p className="text-[12px] leading-[18px] text-muted">
        Message event history may be capped at 1,000 for this page, so delivery history may be incomplete even when the message cursor ends.
      </p>

      {timeline.eventsError && (
        <Alert tone="warn" title="Event history could not load" action={<Retry label="Retry events" onClick={timeline.retryEvents} />}>
          {timeline.eventsError} Messages and consent remain available.
        </Alert>
      )}
      {timeline.messagesError && (
        <Alert
          tone="warn"
          title="Message history could not load"
          action={<Retry label="Retry messages" onClick={timeline.retryMessages} />}
        >
          {timeline.messagesError} Events and consent remain available.
        </Alert>
      )}
      {timeline.consentError && (
        <Alert tone="warn" title="Consent history could not load" action={<Retry label="Retry consent" onClick={timeline.retryConsent} />}>
          {timeline.consentError} Events and messages remain available.
        </Alert>
      )}

      {items.length === 0 ? (
        anyError ? (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState compact title="No history could be loaded">
              Retry a source above. An unavailable source is not the same as no activity.
            </EmptyState>
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState compact title="No recorded activity">
              This person has no loaded events, messages or consent changes.
            </EmptyState>
          </div>
        )
      ) : (
        <ol aria-label="Profile timeline" className="space-y-0">
          {items.map((item) => (
            <li key={item.key} className="flex min-w-0 gap-3 border-b border-line py-3 last:border-0">
              <div className="w-[124px] shrink-0 text-[12px] leading-[18px] text-muted md:w-[148px]">{formatItemDate(item.at)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Tag>{item.source}</Tag>
                  <span className="font-medium break-words text-fg">{item.title}</span>
                </div>
                {item.detail && <p className="mt-0.5 break-words text-[12px] leading-[18px] text-muted">{item.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {(timeline.eventsCursor || timeline.messagesCursor || timeline.eventsMoreError || timeline.messagesMoreError) && (
        <div className="space-y-2">
          {timeline.eventsMoreError && (
            <Alert tone="bad" onRetry={timeline.loadMoreEvents}>
              {timeline.eventsMoreError}
            </Alert>
          )}
          {timeline.messagesMoreError && (
            <Alert tone="bad" onRetry={timeline.loadMoreMessages}>
              {timeline.messagesMoreError}
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {timeline.eventsCursor && (
              <Button onClick={timeline.loadMoreEvents} loading={timeline.loadingMoreEvents}>
                Load more events
              </Button>
            )}
            {timeline.messagesCursor && (
              <Button onClick={timeline.loadMoreMessages} loading={timeline.loadingMoreMessages}>
                Load more messages
              </Button>
            )}
          </div>
        </div>
      )}

      <p className="text-[12px] leading-[18px] text-muted">
        Latest event in period: Unavailable · this history has no bounded period. Latest loaded timestamp: {latest}.
      </p>
    </section>
  );
}

function Retry({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={onClick}>
      {label}
    </Button>
  );
}

function formatItemDate(iso: string): string {
  // Dates and times come from the same formatter as the rest of the admin, in the workspace zone.
  return formatDateTime(iso);
}
