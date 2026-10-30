import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { ButtonLink } from '../../app/links';
import { Link, navigate } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, Card, formatDate, formatDateTime, Meta, StatusPill, Tag, timeAgo, useToast } from '../../ui';
import { defaultLevels, type MandateContent, type MandateScope } from '../artifacts/MandateEditor';
import type { Agent } from './labels';

// The mandate that applies to an agent right now (#223, #228): its link, when it expires (a warning
// within three days), and the way to grant one when the agent has none.

interface MandateDetail {
  id: string;
  name: string;
  latestVersion: number;
  publishedVersion: number | null;
  updatedAt: string;
  latestState: 'draft' | 'in_review' | 'published' | 'superseded' | 'rejected';
  latest: MandateContent;
  published: MandateContent | null;
}

const EMPTY_SCOPE: MandateScope = {
  segments: [],
  purposes: [],
  topics: [],
  channels: ['email'],
  artifactTypes: [],
  artifacts: [],
  brand: null,
};

/** A short sentence about what the mandate touches. */
export function scopeSummary(scope: MandateScope | undefined): string {
  if (!scope) return '';
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (scope.segments.length) parts.push(count(scope.segments.length, 'audience', 'audiences'));
  if (scope.purposes.length) parts.push(count(scope.purposes.length, 'purpose', 'purposes'));
  if (scope.artifactTypes.length) parts.push(count(scope.artifactTypes.length, 'artifact type', 'artifact types'));
  if (scope.channels.length) parts.push(scope.channels.join(', '));
  return parts.join(' · ');
}

const isActive = (m: MandateContent | null): m is MandateContent => !!m && new Date(m.validUntil).getTime() > Date.now();

export function MandateCard({ agent }: { agent: Agent }) {
  const { can } = useWorkspace();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const mandates = useApi(async () => {
    const [list, autonomy] = await Promise.all([
      api.call('artifacts.list', { type: 'agent_mandate', limit: 200 }),
      api.call('workspace.autonomy', {}),
    ]);
    const details = (
      await Promise.all(
        list.artifacts.map(async (a): Promise<MandateDetail | null> => {
          const latest = await api.call('artifacts.get', { artifactId: a.id });
          const latestContent = latest.version.content as MandateContent;
          let published: MandateContent | null = null;
          if (a.publishedVersion) {
            published =
              a.publishedVersion === latest.latestVersion
                ? latestContent
                : ((await api.call('artifacts.get', { artifactId: a.id, version: a.publishedVersion })).version.content as MandateContent);
          }
          if (published?.agent !== agent.id && latestContent.agent !== agent.id) return null;
          return {
            id: a.id,
            name: a.name,
            latestVersion: a.latestVersion,
            publishedVersion: a.publishedVersion,
            updatedAt: a.updatedAt,
            latestState: a.latestState,
            latest: latestContent,
            published,
          };
        }),
      )
    ).filter((d): d is MandateDetail => d !== null);
    const active = details.find((d) => d.published?.agent === agent.id && isActive(d.published)) ?? null;
    const draft = details.find((d) => d.latestState === 'draft' && d.latest.agent === agent.id) ?? null;
    return { active, draft, autonomy };
  }, [agent.id]);

  const active = mandates.data?.active ?? null;
  const draft = mandates.data?.draft ?? null;
  const autonomy = mandates.data?.autonomy ?? null;

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const content: MandateContent = {
        agent: agent.id,
        purpose: `Act for this workspace on behalf of ${agent.name}, only within the levels, scope and limits a person sets here.`,
        levels: defaultLevels(autonomy),
        scope: { ...EMPTY_SCOPE, channels: ['email'] },
        limits: {},
        guardrails: { window: 'P7D', minSent: 100 },
        validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        blackoutDates: [],
        holdWindow: 'PT2H',
        escalation: { userIds: [] },
        independentCheck: false,
        goals: [],
      };
      const r = await api.call('artifacts.create', {
        type: 'agent_mandate',
        name: `${agent.name} mandate`,
        content: content as never,
        note: `Granted to ${agent.name} from its agent page.`,
      });
      toast.success('Created the mandate as a draft. Fill it in, then submit it for review.');
      navigate(artifactPath('agent_mandate', r.artifactId));
    } catch (e) {
      setCreateError(errText(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card
      title="Mandate"
      description="The borders a person grants this agent: a level per action class, its scope, limits and guardrails."
      action={
        active ? (
          <ButtonLink to={artifactPath('agent_mandate', active.id)} variant="secondary">
            Open mandate
          </ButtonLink>
        ) : draft ? (
          <ButtonLink to={artifactPath('agent_mandate', draft.id)} variant="secondary">
            Open the draft
          </ButtonLink>
        ) : can('artifacts:write') ? (
          <Button variant="primary" icon={<Plus size={14} />} loading={creating} onClick={() => void create()}>
            Create mandate
          </Button>
        ) : undefined
      }
    >
      <div className="p-4">
        {mandates.loading && !mandates.data ? (
          <p className="text-[13px] text-muted">Loading the agent’s mandate…</p>
        ) : mandates.error ? (
          <Alert tone="bad" title="Couldn't load the agent's mandate" onRetry={() => void mandates.reload()}>
            {mandates.error}
          </Alert>
        ) : active ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={artifactPath('agent_mandate', active.id)} className="font-medium text-fg hover:underline">
                {active.name}
              </Link>
              <StatusPill tone="good">Active</StatusPill>
              <Tag>v{active.publishedVersion ?? active.latestVersion}</Tag>
            </div>
            <p className="max-w-[720px] text-[13px] text-fg-2">{active.published?.purpose}</p>
            <Meta
              items={[
                [
                  'Expires',
                  <>
                    {formatDate(active.published?.validUntil)}
                    <span className="text-muted">
                      {' '}
                      · {Math.max(0, Math.ceil((new Date(active.published?.validUntil ?? 0).getTime() - Date.now()) / 86_400_000))} days
                      left
                    </span>
                  </>,
                ],
                ['Scope', scopeSummary(active.published?.scope) || 'Everything the levels allow'],
                ['Updated', timeAgo(active.updatedAt)],
              ]}
            />
            {active.published &&
              isActive(active.published) &&
              new Date(active.published.validUntil).getTime() - Date.now() <= 3 * 86_400_000 && (
                <Alert tone="warn" title="This mandate expires within three days">
                  It ends on {formatDateTime(active.published.validUntil)}. Publish a renewed version before then, or the agent falls back
                  to the approval policy.
                </Alert>
              )}
            {active.latestState === 'draft' && (
              <Alert tone="info" title={`A newer draft (v${active.latestVersion}) is not live`}>
                The active mandate is v{active.publishedVersion ?? active.latestVersion}.{' '}
                <Link to={artifactPath('agent_mandate', active.id)} className="underline">
                  Review the draft
                </Link>{' '}
                and submit it to renew.
              </Alert>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[13px] text-fg-2">
              No active mandate. This agent follows the workspace approval policy and ceilings until a person grants one.
            </p>
            {draft && (
              <Alert tone="info" title={`A draft mandate (v${draft.latestVersion}) is not live`}>
                <Link to={artifactPath('agent_mandate', draft.id)} className="underline">
                  Finish and submit it
                </Link>{' '}
                to put its levels and scope in force.
              </Alert>
            )}
            {createError && (
              <Alert tone="bad" title="Could not create the mandate">
                {createError}
              </Alert>
            )}
            {!can('artifacts:write') && <p className="text-[12px] text-muted">A builder can create a mandate for this agent.</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
