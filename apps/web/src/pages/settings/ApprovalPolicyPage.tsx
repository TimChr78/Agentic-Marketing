import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useWorkspace, type Workspace } from '../../app/session';
import { usePageTab } from '../../app/useTab';
import { AutonomyCard } from '../../features/agents/AutonomyCard';
import { useAutonomy } from '../../features/agents/AutonomyProvider';
import { Alert, Button, Card, LoadingBlock, Meta, PageHeader, RadioCards, StatusPill, Tabs, useConfirm, useToast } from '../../ui';
import { pageWidth } from '../../ui/layout';

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

/** The workspace approval policy, shown read-only to people who cannot change it. */
export function PolicySection() {
  useCrumbs([{ label: 'Approval policy' }]);
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

  if (!canAdmin) {
    const info = POLICY_INFO[workspace.approvalPolicy];
    return (
      <div>
        <PageHeader
          title="Approval policy"
          description="How much review a change needs before it goes live. Agents can never approve a change."
        />
        <Card title="Current policy" padded>
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
        </Card>
      </div>
    );
  }

  const options = (Object.keys(POLICY_INFO) as Policy[]).map((value) => ({
    value,
    label: POLICY_INFO[value].label,
    hint: `${POLICY_INFO[value].description} ${POLICY_INFO[value].agent}`,
  }));

  return (
    <div className={pageWidth('reading')}>
      <PageHeader
        title="Approval policy"
        description="How much review a change needs before it goes live. Under every policy, agents can never approve a change."
      />
      <Card title="Who has to approve a change" description="This applies to every artifact and broadcast in the workspace." padded>
        <RadioCards name="approval-policy" value={selected} onChange={setSelected} options={options} />
        <p className="mt-3 text-[12px] text-muted">
          Agents can never approve a change, whatever the policy. Approval is always a person’s decision.
        </p>
        {error && (
          <Alert tone="bad" title="Not saved" className="mt-4">
            {error}
          </Alert>
        )}
        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            loading={busy}
            disabled={selected === workspace.approvalPolicy}
            title={selected === workspace.approvalPolicy ? 'Choose another policy first.' : undefined}
            onClick={() => void save()}
          >
            Save policy
          </Button>
        </div>
      </Card>
      {confirmDialog}
    </div>
  );
}

const POLICY_TABS = ['policy', 'autonomy'] as const;
type PolicyTab = (typeof POLICY_TABS)[number];

const POLICY_TAB_ITEMS: { key: PolicyTab; label: string }[] = [
  { key: 'policy', label: 'Policy' },
  { key: 'autonomy', label: 'Agent autonomy' },
];

/** The workspace autonomy controls that used to sit on Agents, reusing their existing gates. */
function AutonomyTab() {
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
    <div className={pageWidth('reading', 'space-y-5')}>
      <PageHeader
        title="Agent autonomy"
        description="How far agents may act before a person steps in. These controls apply to every agent in the workspace."
      />
      <AutonomyCard
        settings={autonomy.settings}
        canEdit={can('workspace:admin')}
        onSave={async (patch) => {
          await autonomy.save(patch);
          toast.success('Saved the autonomy settings. They apply to the next agent request.');
        }}
      />
    </div>
  );
}

/** Settings → Approval policy and agent autonomy (#446): Policy and Agent autonomy as named tabs. */
export default function ApprovalPolicyPage() {
  const { active, invalid, select } = usePageTab({ keys: POLICY_TABS, fallback: 'policy' });
  useCrumbs([{ label: 'Approval policy and agent autonomy' }]);

  return (
    <div className={pageWidth('default')}>
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={POLICY_TAB_ITEMS} value={active} onChange={select} label="Approval policy and agent autonomy">
        {active === 'autonomy' ? <AutonomyTab /> : <PolicySection />}
      </Tabs>
    </div>
  );
}
