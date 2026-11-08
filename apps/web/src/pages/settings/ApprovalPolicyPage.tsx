import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useWorkspace, type Workspace } from '../../app/session';
import { usePageTab } from '../../app/useTab';
import { AutonomyCard } from '../../features/agents/AutonomyCard';
import { useAutonomy } from '../../features/agents/AutonomyProvider';
import { Alert, Button, LoadingBlock, Meta, RadioCards, StatusPill, useConfirm, useToast } from '../../ui';
import { DetailPage } from '../../ui/DetailPage';

type Policy = Workspace['approvalPolicy'];

const POLICY_INFO: Record<Policy, { label: string; description: string; agent: string; aftermath: string }> = {
  none: {
    label: 'No review',
    description: 'Publishing is immediate.',
    agent: 'For agents: they can publish directly, like people.',
    aftermath: 'Anything anyone publishes goes live at once, including changes an agent wrote. Nobody has to look at it first.',
  },
  agent_changes: {
    label: 'Review agent changes',
    description: 'People publish their own edits; anything an agent wrote goes to a person.',
    agent: 'For agents: their changes wait for a person to approve them.',
    aftermath: 'People can publish their own edits immediately. Only work an agent wrote still waits for a person.',
  },
  all_publishes: {
    label: 'Four-eyes',
    description: 'Every change needs someone else’s approval.',
    agent: 'For agents: they submit, and a person approves before anything goes live.',
    aftermath: 'Every change needs approval by someone other than the person who submitted it. Nobody publishes directly.',
  },
};

const RANK: Record<Policy, number> = { none: 0, agent_changes: 1, all_publishes: 2 };

const POLICY_TABS = ['policy', 'autonomy'] as const;
type PolicyTab = (typeof POLICY_TABS)[number];

const TAB_ITEMS: { key: PolicyTab; label: string }[] = [
  { key: 'policy', label: 'Policy' },
  { key: 'autonomy', label: 'Agent autonomy' },
];

/** Read-only policy summary for people who cannot change it. */
function ReadOnlyPolicy() {
  const { workspace } = useWorkspace();
  const info = POLICY_INFO[workspace.approvalPolicy];
  return (
    <div className="max-w-[640px]">
      <Meta
        items={[
          [
            'Policy',
            <StatusPill key="policy" tone="info">
              {info.label}
            </StatusPill>,
          ],
          ['What happens', info.aftermath],
          ['Agents', info.agent],
        ]}
      />
      <p className="mt-4 text-[12px] text-muted">An admin can change this. Ask an admin if the policy needs to change.</p>
    </div>
  );
}

/** The policy choices, with the consequence of each choice in plain words. */
function PolicyChoices({ selected, onChange }: { selected: Policy; onChange: (p: Policy) => void }) {
  const options = (Object.keys(POLICY_INFO) as Policy[]).map((value) => ({
    value,
    label: POLICY_INFO[value].label,
    hint: `${POLICY_INFO[value].description} ${POLICY_INFO[value].agent}`,
  }));
  return (
    <div className="max-w-[640px] space-y-4">
      <RadioCards name="approval-policy" value={selected} onChange={onChange} options={options} />
      <p className="text-[13px] text-muted">
        Agents can never approve a change, whatever the policy. Approval is always a person’s decision.
      </p>
    </div>
  );
}

/** The workspace autonomy controls that used to sit on Agents, reusing their existing provider and gates. */
function AutonomyPanel() {
  const { can } = useWorkspace();
  const toast = useToast();
  const autonomy = useAutonomy();
  if (autonomy.loading && !autonomy.settings) return <LoadingBlock lines={4} label="Loading autonomy settings" />;
  if (autonomy.error && !autonomy.settings)
    return (
      <Alert tone="bad" title="Couldn't load autonomy settings" onRetry={() => void autonomy.reload()}>
        {autonomy.error}
      </Alert>
    );
  if (!autonomy.settings) return null;
  return (
    <AutonomyCard
      settings={autonomy.settings}
      canEdit={can('workspace:admin')}
      onSave={async (patch) => {
        await autonomy.save(patch);
        toast.success('Saved the autonomy settings. They apply to the next agent request.');
      }}
    />
  );
}

/**
 * Approval policy and agent autonomy (#527): one detail page with the two existing tabs. The save
 * action sits in the header; the policy result and the autonomy read each keep their own state.
 */
export default function ApprovalPolicyPage() {
  const { active, invalid, select } = usePageTab({ keys: POLICY_TABS, fallback: 'policy' });
  useCrumbs([{ label: 'Approval policy and agent autonomy' }]);
  const { workspace, can, refresh } = useWorkspace();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [selected, setSelected] = useState<Policy>(workspace.approvalPolicy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAdmin = can('workspace:admin');

  useEffect(() => {
    setSelected(workspace.approvalPolicy);
  }, [workspace.approvalPolicy]);

  const save = async () => {
    if (selected === workspace.approvalPolicy) return;
    if (RANK[selected] < RANK[workspace.approvalPolicy]) {
      const ok = await confirm({
        title: `Relax the approval policy to “${POLICY_INFO[selected].label}”?`,
        body: <>{POLICY_INFO[selected].aftermath}</>,
        confirmLabel: 'Change policy',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.call('workspace.setApprovalPolicy', { policy: selected });
      await refresh();
      toast.success(`Approval policy set to “${POLICY_INFO[selected].label}”.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DetailPage
        title="Approval policy and agent autonomy"
        kind="Settings"
        statePill={<StatusPill tone="info">{POLICY_INFO[workspace.approvalPolicy].label}</StatusPill>}
        metadata={<span>Applies to every artifact and broadcast in the workspace.</span>}
        state="ready"
        loadingContent={<LoadingBlock lines={4} label="Opening the approval policy" />}
        activeTab={active}
        onTabChange={(key) => select(key as PolicyTab)}
        tabs={TAB_ITEMS.map((tab) =>
          tab.key === 'policy'
            ? {
                ...tab,
                panel: (
                  <div className="space-y-4">
                    {invalid && <Alert tone="info">This tab is unavailable.</Alert>}
                    {canAdmin ? <PolicyChoices selected={selected} onChange={setSelected} /> : <ReadOnlyPolicy />}
                    {error && (
                      <Alert tone="bad" title="Not saved">
                        {error}
                      </Alert>
                    )}
                  </div>
                ),
              }
            : { ...tab, panel: <AutonomyPanel /> },
        )}
        primaryAction={
          active === 'policy' && canAdmin ? (
            <Button
              variant="primary"
              loading={busy}
              disabled={selected === workspace.approvalPolicy}
              title={selected === workspace.approvalPolicy ? 'Choose another policy first.' : undefined}
              onClick={() => void save()}
            >
              Save policy
            </Button>
          ) : undefined
        }
        consequence={
          <div className="space-y-2">
            {invalid && active !== 'policy' && <Alert tone="info">This tab is unavailable.</Alert>}
            <p className="rounded-lg bg-surface-2 px-4 py-3 text-[13px] leading-5 text-fg-2">
              {active === 'autonomy'
                ? 'How far agents may act before a person steps in. These controls apply to every agent in the workspace.'
                : 'The policy applies to every artifact and broadcast. Under every policy, agents can never approve a change.'}
            </p>
          </div>
        }
      />
      {confirmDialog}
    </>
  );
}
