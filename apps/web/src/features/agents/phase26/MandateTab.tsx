import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../../app/api';
import { artifactPath } from '../../../app/artifactRoutes';
import { Link } from '../../../app/router';
import { useWorkspace } from '../../../app/session';
import { useApi } from '../../../app/useApi';
import { Alert, Button, Card, Meta, Skeleton, SkeletonRegion, StatusPill, Table, Tag, Td, THead, Th, Tr } from '../../../ui';
import type { MandateContent } from '../../artifacts/MandateEditor';
import { createMandateDraft } from '../createMandate';
import { actionClassLabel, SWITCH_INFO } from '../labels';
import {
  type AgentDetail,
  type AgentMandate,
  type AutonomySettings,
  blackoutText,
  ceilingLevel,
  computedText,
  grantedLevel,
  guardianCap,
  holdWindowText,
  levelText,
  MATRIX_CLASSES,
  mandateLimitsText,
  mandateScopeText,
  matrixExplanation,
  safeDateText,
  shadowInfo,
  shadowText,
  workingHoursText,
} from './model';

// The Mandate tab (#509): one `agents.mandate` read and one `workspace.autonomy` read, no promise
// scan. Levels are a matrix of action class × granted level × workspace ceiling × guardian cap ×
// explanation. A missing level is the policy default 1, never 0; no active mandate says so plainly.

export function MandateTab({ agentId, agent, canArtifacts }: { agentId: string; agent: AgentDetail; canArtifacts: boolean }) {
  // One read for the selected active mandate. The server has already resolved the published,
  // unarchived, unexpired version and the current working-hours verdict.
  const mandate = useApi(() => api.call('agents.mandate', { agentId }), [agentId], { skip: !canArtifacts });
  const autonomy = useApi(() => api.call('workspace.autonomy', {}), [], { skip: !canArtifacts });

  if (!canArtifacts) {
    return (
      <Alert tone="info" title="Restricted by your role">
        The mandate needs artifact access. No protected reads were made. Ask a workspace administrator for access.
      </Alert>
    );
  }

  if (mandate.refreshing || autonomy.refreshing || (mandate.loading && !mandate.data) || (autonomy.loading && !autonomy.data)) {
    return (
      <SkeletonRegion label="Loading the agent mandate" geometry="detail" className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </SkeletonRegion>
    );
  }

  if (mandate.error) {
    return (
      <Alert tone="bad" title="Couldn't load the agent mandate" onRetry={() => void mandate.reload()}>
        {mandate.error}
      </Alert>
    );
  }

  const data: AgentMandate | undefined = mandate.data;
  if (!data) return null;
  const autonomySettings: AutonomySettings | null = autonomy.error ? null : (autonomy.data ?? null);
  const selected = data.mandate;
  const content = isMandateContent(selected?.content) ? selected.content : null;
  const shadow = shadowInfo(content?.shadow as boolean | string[] | undefined);
  const shadowClasses = shadow.classes.map(actionClassLabel).join(', ');

  return (
    <div className="space-y-5">
      {autonomy.error && (
        <Alert tone="bad" title="Couldn't load the workspace ceiling" onRetry={() => void autonomy.reload()}>
          {autonomy.error} The granted levels are still shown; the ceiling column says Unavailable.
        </Alert>
      )}

      {!selected ? (
        <NoActiveMandate agent={agent} autonomy={autonomySettings} computedAt={computedText(data.asOf)} />
      ) : !content ? (
        <Alert tone="bad" title="Mandate content unavailable">
          The server returned an active mandate, but its published content could not be read. Nothing is treated as a level 0 or as a grant;
          reload the page or ask a workspace administrator to check the mandate.
        </Alert>
      ) : (
        <>
          <Card
            title={
              <span className="flex flex-wrap items-center gap-2">
                Mandate
                <Link to={artifactPath('agent_mandate', selected.id)} className="text-accent hover:underline">
                  Open mandate v{selected.version}
                </Link>
                <StatusPill tone="good">Active</StatusPill>
              </span>
            }
            description="The published, unarchived and unexpired mandate that applies to this agent now. Drafts are never treated as active."
          >
            <div className="space-y-4 p-4">
              {data.outsideHours && (
                <Alert tone="warn" title="Outside working hours">
                  {data.outsideHours} Irreversible actions are capped at level 2 until the working window opens.
                </Alert>
              )}
              {agent.guard && (
                <Alert tone="warn" title="The guardian has capped this agent">
                  {agent.guard.reason} The cap applies on top of the mandate until a person clears it.
                </Alert>
              )}
              {shadow.full && (
                <Alert tone="info" title="Shadow mode is on">
                  The mandate records what it would decide for every action class; nothing runs under it until shadow mode is turned off.
                </Alert>
              )}
              {!shadow.full && shadow.classes.length > 0 && (
                <Alert tone="info" title={`Shadow mode is limited to ${shadowClasses}`}>
                  The mandate records what it would decide only for {shadowClasses}; nothing runs for those classes until shadow mode is
                  turned off. The other classes follow the usual approval policy.
                </Alert>
              )}
              {autonomySettings && autonomySettings.switch !== 'on' && (
                <Alert tone={autonomySettings.switch === 'off' ? 'bad' : 'warn'} title={SWITCH_INFO[autonomySettings.switch].label}>
                  {SWITCH_INFO[autonomySettings.switch].description}
                </Alert>
              )}

              <Meta
                items={[
                  [
                    'Workspace switch',
                    autonomySettings ? (
                      <>
                        <span className="font-medium">{SWITCH_INFO[autonomySettings.switch].label}</span> ·{' '}
                        {SWITCH_INFO[autonomySettings.switch].description}
                      </>
                    ) : (
                      'Unavailable'
                    ),
                  ],
                  ['Scope', mandateScopeText(content.scope)],
                  ['Limits', mandateLimitsText(content.limits)],
                  ['Veto window', holdWindowText(content.holdWindow)],
                  ['Validity', validityText(content.validUntil)],
                  ['Working hours', workingHoursText(content.workingHours)],
                  ['Blackout dates', blackoutText(content.blackoutDates)],
                  ['Shadow mode', shadowText(content.shadow as boolean | string[] | undefined)],
                  ['Computed', computedText(data.asOf)],
                ]}
              />

              <p className="text-[12px] leading-[18px] text-muted">
                A level alone is not permission to execute. Scope, limits, the guardian cap and the approval policy still apply.
              </p>
            </div>
          </Card>

          <Card
            title="Levels by action class"
            description="Rows are the existing action classes. A missing level means the policy default of 1 (Propose), never 0. The workspace ceiling and the guardian cap can both lower the effective level."
          >
            <div className="overflow-x-auto">
              <Table
                label="Mandate levels by action class"
                className="max-sm:block sm:min-w-[720px] max-sm:[&_thead]:hidden max-sm:[&_tbody]:block max-sm:[&_tr]:block max-sm:[&_tr]:border-b max-sm:[&_tr]:border-line max-sm:[&_tr]:last:border-0"
              >
                <THead>
                  <tr>
                    <Th>Action class</Th>
                    <Th>Granted</Th>
                    <Th>Workspace ceiling</Th>
                    <Th>Guardian cap</Th>
                    <Th>Explanation</Th>
                  </tr>
                </THead>
                <tbody>
                  {MATRIX_CLASSES.map((actionClass) => {
                    const granted = grantedLevel(content, actionClass);
                    const ceiling = autonomySettings ? ceilingLevel(autonomySettings, actionClass) : null;
                    const cap = guardianCap(agent.guard, actionClass);
                    const explanation = matrixExplanation({
                      actionClass,
                      granted,
                      ceiling,
                      guard: agent.guard,
                      outsideHours: data.outsideHours,
                      shadow: content.shadow as boolean | string[] | undefined,
                    });
                    return (
                      <Tr key={actionClass} className="max-sm:block max-sm:border-b max-sm:border-line">
                        <Td
                          data-label="Action class"
                          className="max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:border-0 max-sm:px-3 max-sm:py-1 max-sm:font-medium max-sm:text-fg max-sm:before:text-[12px] max-sm:before:font-normal max-sm:before:text-muted max-sm:before:content-[attr(data-label)]"
                        >
                          {actionClassLabel(actionClass)}
                        </Td>
                        <Td
                          data-label="Granted"
                          className="max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:border-0 max-sm:px-3 max-sm:py-1 max-sm:before:text-[12px] max-sm:before:text-muted max-sm:before:content-[attr(data-label)]"
                        >
                          <span>
                            {levelText(granted.level)}
                            {!granted.set && <Tag className="ml-2">Default</Tag>}
                          </span>
                        </Td>
                        <Td
                          data-label="Workspace ceiling"
                          className="max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:border-0 max-sm:px-3 max-sm:py-1 max-sm:before:text-[12px] max-sm:before:text-muted max-sm:before:content-[attr(data-label)]"
                        >
                          {ceiling === null ? 'Unavailable' : levelText(ceiling)}
                        </Td>
                        <Td
                          data-label="Guardian cap"
                          className="max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:border-0 max-sm:px-3 max-sm:py-1 max-sm:before:text-[12px] max-sm:before:text-muted max-sm:before:content-[attr(data-label)]"
                        >
                          <span title={cap.irreversible ? 'The guardian’s irreversible-action cap applies to this class' : undefined}>
                            {cap.text}
                          </span>
                        </Td>
                        <Td
                          data-label="Explanation"
                          className="max-sm:block max-sm:border-0 max-sm:px-3 max-sm:pt-1 max-sm:pb-2 max-sm:text-[12px] max-sm:text-muted max-sm:before:text-[12px] max-sm:before:font-normal max-sm:before:text-muted max-sm:before:content-[attr(data-label)]"
                        >
                          <span className="max-sm:block max-sm:pt-0.5">{explanation}</span>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function NoActiveMandate({
  agent,
  autonomy,
  computedAt,
}: {
  agent: { id: string; name: string };
  autonomy: AutonomySettings | null;
  computedAt: string;
}) {
  const { can } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await createMandateDraft(agent, autonomy);
    } catch (e) {
      setCreateError(errText(e));
    } finally {
      setCreating(false);
    }
  };
  return (
    <Card
      title="No active mandate"
      description="This agent follows the workspace approval policy and ceilings until a person publishes a mandate for it."
      action={
        can('artifacts:write') ? (
          <Button variant="primary" icon={<Plus size={14} />} mutation loading={creating} onClick={() => void create()}>
            Create mandate
          </Button>
        ) : undefined
      }
    >
      {createError && (
        <div className="px-4 pt-4">
          <Alert tone="bad" title="Couldn't create the mandate" onRetry={() => void create()}>
            {createError}
          </Alert>
        </div>
      )}
      <div className="space-y-4 p-4">
        <Alert tone="info" title="No active mandate">
          A draft is never treated as active. When a mandate is published, unarchived and unexpired, its levels and scope appear here.
        </Alert>
        <Meta
          items={[
            [
              'Workspace switch',
              autonomy ? (
                <>
                  <span className="font-medium">{SWITCH_INFO[autonomy.switch].label}</span> · {SWITCH_INFO[autonomy.switch].description}
                </>
              ) : (
                'Unavailable'
              ),
            ],
            ['Computed', computedAt],
          ]}
        />
      </div>
    </Card>
  );
}

/** "Expires 1 Feb 2027 · 87 days left", warning within three days; never a bogus epoch date. */
function validityText(validUntil: string | undefined) {
  const text = validUntil ? safeDateText(validUntil) : 'Unavailable';
  const at = validUntil ? new Date(validUntil).getTime() : Number.NaN;
  if (!Number.isFinite(at) || new Date(at).getFullYear() < 2000) return text;
  const days = Math.max(0, Math.ceil((at - Date.now()) / 86_400_000));
  return (
    <>
      Expires {text}
      <span className={days <= 3 ? 'font-medium text-warn' : 'text-muted'}>
        {' '}
        · {days} {days === 1 ? 'day' : 'days'} left
      </span>
    </>
  );
}

function isMandateContent(value: unknown): value is MandateContent {
  return !!value && typeof value === 'object' && 'levels' in value && 'scope' in value;
}
