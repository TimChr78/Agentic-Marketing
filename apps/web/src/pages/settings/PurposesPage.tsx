import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { navigate } from '../../app/router';
import { ButtonLink } from '../../app/links';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import {
  Alert,
  Button,
  EmptyState,
  Mono,
  PageHeader,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  Td,
  Th,
  THead,
  Tr,
  useToast,
} from '../../ui';

type Purpose = Out<'purposes.list'>['purposes'][number];
type PurposesContent = { purposes: (Purpose & { requiresDoubleOptIn?: boolean })[] };

const BASIS_LABEL: Record<string, string> = {
  consent: 'Consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
};

const basisLabel = (basis: string) => BASIS_LABEL[basis] ?? basis.replace(/_/g, ' ');

/** Purposes: the purposes in force, and a link into the purposes artifact where they are edited. */
export default function PurposesPage() {
  useCrumbs([{ label: 'Purposes' }]);
  const { can } = useWorkspace();
  const toast = useToast();
  const data = useApi(async () => {
    const [current, list] = await Promise.all([
      api.call('purposes.list', {}),
      api.call('artifacts.list', { type: 'purposes', limit: 1 }),
    ]);
    const artifact = list.artifacts[0] ?? null;
    let published: PurposesContent | null = null;
    if (artifact?.publishedVersion) {
      const g = await api.call('artifacts.get', { artifactId: artifact.id, version: artifact.publishedVersion });
      published = g.version.content as PurposesContent;
    }
    return { ...current, artifact, published };
  }, []);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const purposes = data.data?.purposes ?? [];
  const artifact = data.data?.artifact ?? null;
  const source = data.data?.source ?? 'default';
  const canWrite = can('artifacts:write');
  const doubleOptIn = new Map((data.data?.published?.purposes ?? []).map((p) => [p.key, !!p.requiresDoubleOptIn]));

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
            requiresDoubleOptIn: false,
          })),
        },
        note: 'Created from the default purposes.',
      });
      toast.success('Created the purposes artifact as a draft. Edit it, then submit it for review.');
      navigate(`/artifacts/${r.artifactId}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Purposes"
        description="The lawful reasons you may contact people, and the channels each covers. Changes go through review like other artifacts: edit the purposes artifact, submit it, and a person approves it."
        meta={
          <>
            <StatusPill tone={source === 'published' ? 'good' : 'neutral'}>
              {source === 'published' ? 'Published' : 'Defaults'}
            </StatusPill>
            <span>{source === 'published' ? 'These purposes are in force.' : 'The built-in defaults are in force.'}</span>
            {artifact && artifact.publishedVersion === null && <span>A draft exists and is not live yet.</span>}
          </>
        }
        actions={
          artifact ? (
            <ButtonLink to={`/artifacts/${artifact.id}`} variant="primary" icon={<Pencil size={14} />}>
              Edit purposes
            </ButtonLink>
          ) : canWrite ? (
            <Button variant="primary" icon={<Plus size={15} />} loading={creating} onClick={() => void create()}>
              Create purposes
            </Button>
          ) : undefined
        }
      />
      {!artifact && (
        <Alert tone="info" title="No purposes artifact yet" className="mb-4">
          The defaults below apply. {canWrite ? 'Create a purposes artifact to change a basis, its channels or double opt-in.' : 'A builder can create one to change a basis, its channels or double opt-in.'}
        </Alert>
      )}
      {error && (
        <Alert tone="bad" title="Could not create the purposes artifact" className="mb-4">
          {error}
        </Alert>
      )}
      <TableFrame
        loading={data.loading}
        error={data.error}
        onRetry={data.reload}
        columns={4}
        isEmpty={purposes.length === 0}
        empty={<EmptyState title="No purposes">Add purposes to the purposes artifact. Until then the built-in defaults apply.</EmptyState>}
      >
        <Table label="Purposes">
          <THead>
            <tr>
              <Th>Purpose</Th>
              <Th>Lawful basis</Th>
              <Th>Channels</Th>
              <Th>Double opt-in</Th>
            </tr>
          </THead>
          <tbody>
            {purposes.map((p) => {
              const doubleOptInOn = doubleOptIn.get(p.key) ?? false;
              return (
                <Tr key={p.key}>
                  <Td>
                    <div className="font-medium text-fg">{p.name}</div>
                    <div className="mt-0.5">
                      <Mono>{p.key}</Mono>
                    </div>
                    {p.description && <p className="mt-1 max-w-[420px] text-[12px] text-muted">{p.description}</p>}
                  </Td>
                  <Td className="whitespace-nowrap">{basisLabel(p.basis)}</Td>
                  <Td>
                    {p.channels.length ? (
                      <span className="flex flex-wrap gap-1">
                        {p.channels.map((c) => (
                          <Tag key={c}>{c}</Tag>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </Td>
                  <Td>{doubleOptInOn ? 'Yes' : <span className="text-muted">No</span>}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableFrame>
    </div>
  );
}
