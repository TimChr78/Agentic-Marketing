import { RefreshCw, Send } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { setSearchParam, useLocation } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { type ArtifactDetailActionContext, ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { BroadcastEditor } from '../../features/artifacts/BroadcastEditor';
import { BroadcastStatePill } from '../../features/artifacts/BroadcastState';
import { BroadcastStatus } from '../../features/artifacts/BroadcastStatus';
import { BroadcastConsequence } from '../../features/broadcasts/BroadcastConsequence';
import { BroadcastContext } from '../../features/broadcasts/BroadcastContext';
import { BroadcastReport } from '../../features/broadcasts/BroadcastReport';
import {
  type BroadcastContent,
  broadcastConsequenceOf,
  broadcastDetailStateOf,
  broadcastPrimaryActionOf,
  defaultBroadcastTab,
  isBroadcastTab,
} from '../../features/broadcasts/detailView';
import { useArtifactNames } from '../../features/broadcasts/names';
import { publicationLabel } from '../../lib/state';
import { Button, Skeleton, timeAgo } from '../../ui';
import { Identifier } from '../../ui/Identifier';

/**
 * Broadcast detail (#448) on the v2 detail template. One `broadcasts.status` read is shared by the
 * pill, consequence summary, Sending panel and context panel; `artifacts.get` and the pending
 * approvals read still come from the artifact page. The primary action is chosen by the runtime
 * state before the latest draft state, and the tabs live in the URL.
 */
export default function BroadcastPage({ params }: { params: Record<string, string> }) {
  const id = params.id;
  const { can } = useWorkspace();
  const canRead = can('artifacts:read');
  const { search } = useLocation();
  const status = useApi(() => api.call('broadcasts.status', { artifactId: id }), [id], { skip: !canRead });
  const segmentNames = useArtifactNames('segment', { skip: !canRead });
  const templateNames = useArtifactNames('email_template', { skip: !canRead });
  const names = useMemo(
    () => new Map([...(segmentNames.data ?? new Map()), ...(templateNames.data ?? new Map())]),
    [segmentNames.data, templateNames.data],
  );

  const urlTab = search.get('tab');
  const [tab, setTab] = useState<string>(() => (isBroadcastTab(urlTab) ? urlTab : 'content'));
  const choseTab = useRef(false);
  const lastUrlTab = useRef(urlTab);
  useEffect(() => {
    if (urlTab === lastUrlTab.current) return;
    lastUrlTab.current = urlTab;
    setTab(isBroadcastTab(urlTab) ? urlTab : status.data ? defaultBroadcastTab(status.data) : 'content');
  }, [urlTab, status.data]);
  useEffect(() => {
    if (choseTab.current || isBroadcastTab(urlTab)) return;
    if (status.data) setTab(defaultBroadcastTab(status.data));
  }, [status.data, urlTab]);
  const changeTab = (key: string) => {
    choseTab.current = true;
    setTab(key);
    if (isBroadcastTab(key)) setSearchParam('tab', key);
  };

  // While a run is sending, refresh only when the page is visible; otherwise revalidate on focus.
  const runStatus = status.data?.run.status;
  useEffect(() => {
    if (runStatus !== 'running') return;
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void status.reload();
    };
    const timer = setInterval(refreshIfVisible, 10_000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [runStatus, status.reload]);
  useEffect(() => {
    const onFocus = () => void status.reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [status.reload]);

  const contentOf = (artifact: Parameters<typeof broadcastDetailStateOf>[0]['artifact'], draft: unknown, dirty: boolean) =>
    (dirty && draft ? draft : (artifact.version.content ?? {})) as BroadcastContent;

  const renderPrimary = (ctx: ArtifactDetailActionContext): ReactNode => {
    const state = ctx.artifact.version.state;
    const action = broadcastPrimaryActionOf({
      artifact: ctx.artifact,
      run: status.data?.run ?? null,
      statusError: status.error,
      dirty: ctx.dirty,
      readOnly: ctx.readOnly,
      canSubmit: can('artifacts:publish') && (state === 'draft' || state === 'rejected') && !ctx.dirty,
      directPublish: ctx.directPublish,
      canApprove: ctx.canApprove,
      pendingId: ctx.pending?.id ?? null,
    });
    switch (action.kind) {
      case 'save':
        return (
          <Button variant="primary" loading={ctx.saving} onClick={() => void ctx.save()}>
            {action.label}
          </Button>
        );
      case 'publish':
        return (
          <Button variant="primary" icon={<Send size={14} />} onClick={ctx.openPublish}>
            {action.label}
          </Button>
        );
      case 'tab':
        return (
          <Button variant="primary" onClick={() => ctx.openTab(action.tab)}>
            {action.label}
          </Button>
        );
      case 'link':
        return (
          <ButtonLink to={action.to} variant="primary">
            {action.label}
          </ButtonLink>
        );
      case 'retry':
        return (
          <Button variant="primary" icon={<RefreshCw size={14} />} onClick={status.reload}>
            {action.label}
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <ArtifactDetailPage
      id={id}
      crumbs={[{ label: 'Broadcasts', to: '/marketing/broadcasts' }]}
      editor={(p) => <BroadcastEditor {...p} />}
      tab={tab}
      onTabChange={changeTab}
      extraTabs={[
        {
          key: 'sending',
          label: 'Sending',
          render: (a) => (
            <BroadcastStatus
              artifact={a}
              status={{ data: status.data, loading: status.loading, error: status.error, reload: status.reload }}
            />
          ),
        },
        { key: 'report', label: 'Report', render: (a) => <BroadcastReport artifactId={a.id} active={tab === 'report'} /> },
      ]}
      state={(a) =>
        status.loading ? (
          <Skeleton className="h-5 w-24 rounded-full" />
        ) : (
          <BroadcastStatePill
            state={broadcastDetailStateOf({
              artifact: a,
              run: status.data?.run ?? null,
              stage: status.data?.stage ?? null,
              delivery: status.data?.delivery ?? null,
              statusError: status.error,
            })}
          />
        )
      }
      detail={{
        kind: 'Broadcast',
        notFoundTitle: 'Broadcast not found',
        errorTitle: 'Couldn’t open this broadcast',
        backTo: '/marketing/broadcasts',
        backLabel: 'Back to broadcasts',
        restrictedTitle: 'Broadcasts are restricted',
        restrictedBody: 'Reading broadcasts needs the artifacts:read permission. Ask a workspace admin to give you access.',
        metadata: (a) => (
          <>
            <span>{publicationLabel({ latestVersion: a.latestVersion, publishedVersion: a.publishedVersion })}</span>
            <span>changed by {a.version.by?.displayName ?? (a.version.author.type === 'agent' ? 'an agent' : 'a person')}</span>
            <span>{timeAgo(a.version.createdAt)}</span>
            <Identifier value={a.id} label="Broadcast ID" />
          </>
        ),
        consequence: (a, view) => {
          const content = contentOf(a, view.draft, view.dirty);
          return (
            <BroadcastConsequence
              lines={broadcastConsequenceOf({
                artifact: a,
                run: status.data?.run ?? null,
                stage: status.data?.stage ?? null,
                delivery: status.data?.delivery ?? null,
                statusError: status.error,
                dirty: view.dirty,
                draft: view.draft,
                segmentName: content.segment ? names.get(content.segment)?.name : undefined,
                hasPending: view.hasPending,
              })}
              templateName={content.template ? names.get(content.template)?.name : undefined}
            />
          );
        },
        context: (a) => {
          const content = a.version.content as BroadcastContent;
          return (
            <BroadcastContext
              artifact={a}
              status={{ data: status.data, loading: status.loading, error: status.error }}
              segmentName={content.segment ? names.get(content.segment)?.name : undefined}
              templateName={content.template ? names.get(content.template)?.name : undefined}
              names={names}
            />
          );
        },
        actions: (ctx) => {
          const state = ctx.artifact.version.state;
          const action = broadcastPrimaryActionOf({
            artifact: ctx.artifact,
            run: status.data?.run ?? null,
            statusError: status.error,
            dirty: ctx.dirty,
            readOnly: ctx.readOnly,
            canSubmit: can('artifacts:publish') && (state === 'draft' || state === 'rejected') && !ctx.dirty,
            directPublish: ctx.directPublish,
            canApprove: ctx.canApprove,
            pendingId: ctx.pending?.id ?? null,
          });
          const secondary: ReactNode[] = [];
          if (ctx.dirty && !ctx.readOnly) {
            if (action.kind !== 'save') {
              secondary.push(
                <Button key="save" variant="ghost" loading={ctx.saving} onClick={() => void ctx.save()}>
                  Save draft
                </Button>,
              );
            }
            secondary.push(
              <Button key="discard" variant="ghost" onClick={ctx.resetToSaved}>
                Discard changes
              </Button>,
            );
          }
          return { primary: renderPrimary(ctx), secondary: secondary.length ? secondary : undefined };
        },
      }}
    />
  );
}
