import { useEffect, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useWorkspace, type Workspace } from '../../app/session';
import { Alert, Button, Card, Meta, PageHeader, RadioCards, StatusPill, useConfirm, useToast } from '../../ui';
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
export default function ApprovalPolicyPage() {
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
