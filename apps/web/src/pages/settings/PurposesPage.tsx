import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { navigate } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { invalidatePickerIndex } from '../../features/artifacts/pickerIndex';
import { Alert, Button, EmptyState, Mono, StatusPill, Table, TableFrame, Tag, Td, THead, Th, Tr, useToast } from '../../ui';

const BASIS_LABEL: Record<string, string> = {
  consent: 'Consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
};

const basisLabel = (basis: string) => BASIS_LABEL[basis] ?? basis.replace(/_/g, ' ');

const refused = (c: { denied: number; withdrawn: number; objected: number }) => c.denied + c.withdrawn + c.objected;

/**
 * Purposes: the definitions in force, and the way into the purposes artifact where they are edited.
 * It is a section of Consent, so it has no page heading or crumbs of its own.
 */
export default function PurposesPage() {
  const { can, workspace } = useWorkspace();
  const toast = useToast();
  const data = useApi(async () => {
    const [current, list] = await Promise.all([api.call('purposes.list', {}), api.call('artifacts.list', { type: 'purposes', limit: 1 })]);
    return { ...current, artifact: list.artifacts[0] ?? null };
  }, []);
  // Counts are about people, not the artifact, so they are a separate read under profiles:read.
  const summary = useApi(() => api.call('consent.summary', {}), [], { skip: !can('profiles:read') });
  const counts = new Map((summary.data?.purposes ?? []).map((p) => [p.purpose, p]));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const purposes = data.data?.purposes ?? [];
  const artifact = data.data?.artifact ?? null;
  const source = data.data?.source ?? 'default';
  const canWrite = can('artifacts:write');

  const create = async () => {
    if (!data.data) return;
    setCreating(true);
    setError(null);
    try {
      const r = await api.call('artifacts.create', {
        type: 'purposes',
        name: 'Purposes',
        content: {
          purposes: data.data.purposes.map((p) => ({
            key: p.key,
            name: p.name,
            description: p.description,
            basis: p.basis,
            channels: p.channels,
            requiresDoubleOptIn: p.requiresDoubleOptIn,
          })),
        },
        note: 'Created from the default purposes.',
      });
      // A new purposes artifact is a new row for the type's shared index; no other index changes.
      invalidatePickerIndex(workspace.id, 'purposes');
      toast.success('Created the purposes artifact as a draft. Edit it, then submit it for review.');
      navigate(`/artifacts/${r.artifactId}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section aria-labelledby="purposes-in-force">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="purposes-in-force" className="text-[16px] leading-6 font-semibold">
            Purposes in force
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-muted">
            <StatusPill tone={source === 'published' ? 'good' : 'neutral'}>{source === 'published' ? 'Published' : 'Defaults'}</StatusPill>
            <span>{source === 'published' ? 'These purposes are in force.' : 'The built-in defaults are in force.'}</span>
            {artifact && artifact.publishedVersion === null && <span>A draft exists and is not live yet.</span>}
          </div>
          <p className="mt-1 max-w-[760px] text-[13px] leading-5 text-muted">
            The lawful reasons you may contact people, and the channels each covers. Changes go through review like other artifacts: edit
            the purposes artifact, submit it, and a person approves it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {artifact ? (
            <ButtonLink to={`/artifacts/${artifact.id}`} variant="primary" icon={<Pencil size={14} />}>
              Edit purposes
            </ButtonLink>
          ) : canWrite ? (
            <Button variant="primary" icon={<Plus size={15} />} loading={creating} onClick={() => void create()}>
              Create purposes
            </Button>
          ) : undefined}
        </div>
      </div>

      {!artifact && (
        <Alert tone="info" title="No purposes artifact yet" className="mt-3 mb-3">
          The defaults below apply.{' '}
          {canWrite
            ? 'Create a purposes artifact to change a basis, its channels or double opt-in.'
            : 'A builder can create one to change a basis, its channels or double opt-in.'}
        </Alert>
      )}
      {error && (
        <Alert tone="bad" title="Could not create the purposes artifact" className="mt-3 mb-3">
          {error}
        </Alert>
      )}

      <TableFrame
        loading={data.loading}
        error={data.error}
        onRetry={data.reload}
        columns={5}
        isEmpty={purposes.length === 0}
        empty={<EmptyState title="No purposes">Add purposes to the purposes artifact. Until then the built-in defaults apply.</EmptyState>}
      >
        <Table label="Purposes">
          <THead>
            <tr>
              <Th>Purpose</Th>
              <Th>Lawful basis</Th>
              <Th>Channels</Th>
              <Th>People</Th>
              <Th>Double opt-in</Th>
            </tr>
          </THead>
          <tbody>
            {purposes.map((p) => {
              const c = counts.get(p.key);
              return (
                <Tr key={p.key}>
                  <Td>
                    <div className="font-medium text-fg">{p.name}</div>
                    <div className="mt-0.5">
                      <Mono>{p.key}</Mono>
                    </div>
                    {p.description && <p className="mt-1 max-w-[360px] text-[12px] leading-[18px] text-muted">{p.description}</p>}
                  </Td>
                  <Td className="whitespace-nowrap">{basisLabel(p.basis)}</Td>
                  <Td>
                    {p.channels.length ? (
                      <span className="flex flex-wrap gap-1">
                        {p.channels.map((ch) => (
                          <Tag key={ch}>{ch}</Tag>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </Td>
                  <Td>
                    {summary.loading ? (
                      <span className="text-muted">…</span>
                    ) : c ? (
                      <div className="space-y-1">
                        <span className="flex flex-wrap gap-1">
                          <StatusPill tone="good">{c.granted} allowed</StatusPill>
                          {refused(c) > 0 && <StatusPill tone="warn">{refused(c)} refused</StatusPill>}
                        </span>
                        {c.channels.length > 0 && (
                          <div className="text-[12px] leading-[18px] text-muted">
                            {c.channels.map((ch) => `${ch.channel}: ${ch.granted} allowed, ${refused(ch)} refused`).join(' · ')}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td>{p.requiresDoubleOptIn ? 'Yes' : <span className="text-muted">No</span>}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableFrame>
    </section>
  );
}
