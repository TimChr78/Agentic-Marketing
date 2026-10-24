import { Plus, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { useCrumbs } from '../../app/page';
import { Link, navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { Alert, Button, EmptyState, Field, Input, Modal, PageHeader, Select, StatePill, StatusPill, Table, TableFrame, Td, Th, THead, timeAgo, Tr, useToast } from '../../ui';

export type ArtifactRow = Out<'artifacts.list'>['artifacts'][number];

export interface CreateSpec<S> {
  /** Label of the primary action, e.g. "New journey". */
  label: string;
  /** Extra fields beyond the name (e.g. template and segment of a broadcast). */
  initial?: S;
  fields?: (state: S, set: (s: S) => void, errors: Record<string, string>) => ReactNode;
  /** Field errors before submitting; empty when valid. */
  validate?: (state: S) => Record<string, string>;
  /** The draft content to create. */
  content: (name: string, state: S) => unknown;
  defaultName?: string;
}

/**
 * A list of one artifact type (DESIGN.md → Layout): title and primary action, a search and state
 * filter, then the table with loading, error and empty states.
 */
export function ArtifactListPage<S = Record<string, never>>({
  type,
  title,
  description,
  crumb,
  create,
  emptyTitle,
  emptyText,
  columns,
}: {
  type: string;
  title: string;
  description: ReactNode;
  crumb?: string;
  create?: CreateSpec<S>;
  emptyTitle: string;
  emptyText: ReactNode;
  /** Extra columns after the name. */
  columns?: { header: string; cell: (a: ArtifactRow) => ReactNode; className?: string }[];
}) {
  useCrumbs([{ label: crumb ?? title }]);
  const { can } = useSession();
  const list = useApi(() => api.call('artifacts.list', { type: type as never, limit: 200 }), [type]);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [creating, setCreating] = useState(false);
  const rows = useMemo(
    () =>
      (list.data?.artifacts ?? []).filter(
        (a) => (!q || a.name.toLowerCase().includes(q.toLowerCase())) && (!state || (state === 'live' ? a.publishedVersion !== null : a.latestState === state)),
      ),
    [list.data, q, state],
  );
  const total = list.data?.artifacts.length ?? 0;
  const canCreate = !!create && can('artifacts:write');

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        actions={
          canCreate && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
              {create!.label}
            </Button>
          )
        }
      />
      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        isEmpty={rows.length === 0}
        toolbar={
          total > 0 && (
            <>
              <div className="relative w-full max-w-[280px]">
                <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
                <Input compact aria-label={`Search ${title.toLowerCase()}`} placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
              </div>
              <Select compact aria-label="State" value={state} onChange={(e) => setState(e.target.value)} className="w-auto">
                <option value="">All states</option>
                <option value="live">Live</option>
                <option value="draft">Draft</option>
                <option value="in_review">In review</option>
                <option value="rejected">Rejected</option>
              </Select>
              <span className="ml-auto text-[12px] text-muted">
                {rows.length === total ? `${total} total` : `${rows.length} of ${total}`}
              </span>
            </>
          )
        }
        empty={
          total === 0 ? (
            <EmptyState
              title={emptyTitle}
              action={
                canCreate && (
                  <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                    {create!.label}
                  </Button>
                )
              }
            >
              {emptyText}
            </EmptyState>
          ) : (
            <EmptyState compact title="Nothing matches">
              Clear the search or choose another state.
            </EmptyState>
          )
        }
      >
        <Table label={title}>
          <THead>
            <tr>
              <Th>Name</Th>
              {columns?.map((c) => (
                <Th key={c.header} className={c.className}>
                  {c.header}
                </Th>
              ))}
              <Th>State</Th>
              <Th className="hidden md:table-cell">Live</Th>
              <Th>Updated</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((a) => (
              <Tr key={a.id} onClick={() => navigate(artifactPath(a.type, a.id))}>
                <Td>
                  <Link to={artifactPath(a.type, a.id)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                    {a.name}
                  </Link>
                </Td>
                {columns?.map((c) => (
                  <Td key={c.header} className={c.className}>
                    {c.cell(a)}
                  </Td>
                ))}
                <Td>
                  <StatePill state={a.latestState} />
                </Td>
                <Td className="hidden md:table-cell">
                  {a.publishedVersion ? <StatusPill tone="good">v{a.publishedVersion}</StatusPill> : <span className="text-muted">Not live</span>}
                </Td>
                <Td className="whitespace-nowrap">{timeAgo(a.updatedAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {create && creating && <CreateDialog type={type} spec={create} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateDialog<S>({ type, spec, onClose }: { type: string; spec: CreateSpec<S>; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(spec.defaultName ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [state, setState] = useState<S>(spec.initial ?? ({} as S));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const e = spec.validate?.(state) ?? {};
    setErrors(e);
    if (!name.trim()) setNameError('Give it a name people will recognise.');
    if (!name.trim() || Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('artifacts.create', { type: type as never, name: name.trim(), content: spec.content(name.trim(), state) });
      toast.success(`Created “${name.trim()}” as a draft.`);
      onClose();
      navigate(artifactPath(type, r.artifactId));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={spec.label}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Create draft
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" error={nameError} hint="Shown to reviewers and agents." required>
          <Input
            value={name}
            data-autofocus
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            onBlur={() => !name.trim() && setNameError('Give it a name people will recognise.')}
            maxLength={120}
          />
        </Field>
        {spec.fields?.(state, setState, errors)}
        {error && <Alert tone="bad">{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
