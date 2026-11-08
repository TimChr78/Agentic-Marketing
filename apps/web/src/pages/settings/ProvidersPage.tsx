import { Fragment } from 'react';
import { useCrumbs } from '../../app/page';
import { ChannelCards, ChannelTable } from '../../features/phase27/settings/channels';
import { useEmailChannel } from '../../features/providers/EmailProviders';
import { useAiChannel, usePushChannel, useSmsChannel } from '../../features/providers/OtherProviders';
import { Button, ListSkeleton } from '../../ui';
import { ListPage } from '../../ui/ListPage';

/**
 * Providers (#527): one compact row per configured provider, grouped by channel. Each channel's
 * read is independent, so one failed channel leaves the others usable; every adapter field,
 * credential rule and one-time secret stays in the channel's Add/Edit drawer.
 */
export default function ProvidersPage() {
  useCrumbs([{ label: 'Providers' }]);
  const email = useEmailChannel();
  const sms = useSmsChannel();
  const push = usePushChannel();
  const ai = useAiChannel();
  const channels = [email, sms, push, ai];

  const configured = channels.filter((c) => c.rows.length > 0).length;
  const failed = channels.filter((c) => c.error);
  const partial = failed.length > 0 && failed.length < channels.length;
  const allLoading = channels.every((c) => c.loading && c.rows.length === 0);
  const allFailed = channels.every((c) => c.error && c.rows.length === 0);
  const state = allLoading ? 'loading' : allFailed ? 'error' : 'ready';

  const retryAll = () => {
    for (const channel of channels) channel.onRetry();
  };

  // A partial read says only which channels failed; the channels that answered stay usable.
  const notice = partial
    ? {
        title: 'Some provider channels couldn’t load',
        body: (
          <>
            {failed.map((c) => c.label).join(', ')} could not be read. The other {channels.length - failed.length}{' '}
            {channels.length - failed.length === 1 ? 'channel loaded' : 'channels loaded'} and remain usable. Retry to read the failed
            {failed.length === 1 ? ' channel' : ' channels'} again; saved values are unchanged.
          </>
        ),
        action: (
          <Button size="sm" variant="ghost" onClick={retryAll}>
            Retry
          </Button>
        ),
      }
    : {
        title: 'Couldn’t load providers',
        body: 'Provider configuration is unavailable. Retry to read it again; saved values are unchanged.',
        action: (
          <Button size="sm" variant="ghost" onClick={retryAll}>
            Retry
          </Button>
        ),
      };

  const notices = channels.some((c) => c.notices) && (
    <div className="space-y-2 border-b border-line p-3">
      {channels.map((channel) => (
        <Fragment key={channel.key}>{channel.notices}</Fragment>
      ))}
    </div>
  );

  return (
    <div>
      <ListPage
        title="Providers"
        description="Services that deliver your messages and run AI steps. Each use goes through one provider; credentials are encrypted and can be replaced, never read back."
        countLabel={state === 'ready' ? `${configured} of ${channels.length} channels configured` : undefined}
        state={state}
        notice={notice}
        loadingContent={<ListSkeleton label="Loading providers" />}
        desktopTable={
          <>
            {notices}
            <ChannelTable channels={channels} />
          </>
        }
        mobileList={
          <>
            {notices}
            <ChannelCards channels={channels} />
          </>
        }
      />
      {channels.map((channel) => (
        <Fragment key={channel.key}>{channel.overlay}</Fragment>
      ))}
    </div>
  );
}
