import { Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { parseCsv } from '../../lib/csvImport';
import { Alert, Button, Field, Modal, Select, Table, TableFrame, Td, THead, Th, Tr, timeAgo, useToast } from '../../ui';

// A static or snapshot audience's member list (#83). Membership is data, not an artifact version:
// adding, importing and removing take effect at once, and sends still check consent and suppression.

type Member = Out<'segments.members'>['members'][number];
type ImportResult = Out<'audiences.import'>;
type Unmatched = ImportResult['unmatched'][number];
type AddUnmatched = Out<'audiences.add'>['unmatched'][number];

export function ListAudiencePanel({ artifactId, content }: { artifactId: string; content: SegmentContent }) {
  const { can } = useSession();
  const toast = useToast();
  const mayWrite = can('profiles:write');
  const maySeeEmail = can('profiles:pii');
  const [after, setAfter] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const members = useApi(() => api.call('segments.members', { artifactId, limit: 50, after }), [artifactId, after]);
  const imports = useApi(() => api.call('audiences.imports', { segmentId: artifactId, limit: 10 }), [artifactId]);
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (m: Member) => {
    setBusy(m.profileId);
    try {
      const r = await api.call('audiences.remove', { segmentId: artifactId, profileIds: [m.profileId] });
      toast.success(r.removed ? 'Removed from the list.' : 'They were not on the list.');
      await members.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshSnapshot = async () => {
    setBusy('snapshot');
    try {
      const r = await api.call('audiences.refreshSnapshot', { segmentId: artifactId });
      toast.success(`Refreshed: ${r.members} members (${r.added} added, ${r.removed} removed).`);
      await Promise.all([members.reload(), imports.reload()]);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <Alert tone="info">
        Membership is not consent. Sends to this audience still skip people who have not consented to the purpose, who are suppressed, or
        whom the delivery policy excludes.
      </Alert>

      {content.mode === 'snapshot' && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-2 px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-fg">Frozen snapshot</p>
            <p className="text-[12px] text-muted">
              Copied from {content.sourceSegment ?? 'a segment'}
              {content.snapshotVersion ? ` at v${content.snapshotVersion}` : ''}
              {content.snapshotAt ? ` on ${new Date(content.snapshotAt).toLocaleString()}` : ''}. It stays fixed until it is refreshed.
            </p>
          </div>
          {mayWrite && (
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={14} />}
              loading={busy === 'snapshot'}
              onClick={() => void refreshSnapshot()}
            >
              Refresh from source
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-medium text-fg">People in this audience</h2>
        <span className="text-[12px] text-muted">{members.data?.total != null ? `${members.data.total.toLocaleString()} total` : ''}</span>
        <div className="ml-auto flex gap-2">
          {mayWrite && (
            <Button size="sm" variant="secondary" icon={<Upload size={14} />} onClick={() => setImporting(true)}>
              Import CSV
            </Button>
          )}
          {mayWrite && (
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add people
            </Button>
          )}
        </div>
      </div>

      <TableFrame
        loading={members.loading}
        error={members.error}
        onRetry={members.reload}
        isEmpty={!members.loading && !members.error && (members.data?.members.length ?? 0) === 0}
        empty={<p className="p-4 text-[13px] text-muted">No one is on this list yet. Add people or import a CSV.</p>}
      >
        <Table label="Audience members">
          <THead>
            <tr>
              <Th>Person</Th>
              {maySeeEmail && <Th>E-mail</Th>}
              <Th>Added</Th>
              <Th className="w-10" />
            </tr>
          </THead>
          <tbody>
            {members.data?.members.map((m) => (
              <Tr key={m.profileId}>
                <Td className="font-mono text-[12px]">{m.profileId}</Td>
                {maySeeEmail && <Td>{m.email ?? '—'}</Td>}
                <Td className="whitespace-nowrap text-[12px] text-muted">
                  {m.addedAt ? timeAgo(m.addedAt) : timeAgo(m.since)}
                  {m.source ? ` · ${m.source}` : ''}
                </Td>
                <Td>
                  {mayWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={14} />}
                      aria-label={`Remove ${m.profileId}`}
                      loading={busy === m.profileId}
                      onClick={() => void remove(m)}
                    />
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>

      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={!after} onClick={() => setAfter(undefined)}>
          First page
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={(members.data?.members.length ?? 0) < 50}
          onClick={() => setAfter(members.data?.members.at(-1)?.profileId)}
        >
          Next page
        </Button>
      </div>

      <section aria-label="Import history" className="space-y-2">
        <h2 className="text-[13px] font-medium text-fg">Import history</h2>
        {imports.error ? (
          <p className="text-[12px] text-bad">{imports.error}</p>
        ) : !imports.loading && !(imports.data?.imports.length ?? 0) ? (
          <p className="text-[12px] text-muted">No imports or snapshot refreshes yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {imports.data?.imports.map((i) => (
              <li key={i.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
                <span className="font-medium text-fg">{i.source === 'snapshot' ? 'Snapshot refresh' : (i.fileName ?? 'CSV import')}</span>
                <span className="text-muted">
                  {i.rows} rows · {i.matched} matched · {i.added} added
                </span>
                {i.unmatched.length > 0 && <span className="text-warn">{i.unmatched.length} unmatched</span>}
                <span className="ml-auto text-muted">{timeAgo(i.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {adding && (
        <AddPeopleDialog
          artifactId={artifactId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void members.reload();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          artifactId={artifactId}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void Promise.all([members.reload(), imports.reload()]);
          }}
        />
      )}
    </div>
  );
}

function AddPeopleDialog({ artifactId, onClose, onDone }: { artifactId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [idType, setIdType] = useState<'email' | 'user_id' | 'profile_id'>('email');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<AddUnmatched[]>([]);
  const values = useMemo(
    () =>
      text
        .split(/[\n,;]+/)
        .map((v) => v.trim())
        .filter(Boolean),
    [text],
  );

  const submit = async () => {
    if (!values.length) return setError('Enter at least one person.');
    if (values.length > 1000) return setError('At most 1,000 people per call.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('audiences.add', {
        segmentId: artifactId,
        [idType === 'email' ? 'emails' : idType === 'user_id' ? 'userIds' : 'profileIds']: values,
        source: 'manual',
      });
      setUnmatched(r.unmatched);
      if (r.unmatched.length) {
        setError(`${r.added} added, ${r.existing} were already on the list, ${r.unmatched.length} not matched.`);
        if (r.added) toast.success(`Added ${r.added} ${r.added === 1 ? 'person' : 'people'}.`);
      } else {
        toast.success(`Added ${r.added}; ${r.existing} were already on the list.`);
        onDone();
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Add people"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {unmatched.length ? 'Done' : 'Cancel'}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Identify people by">
          <Select value={idType} onChange={(e) => setIdType(e.target.value as typeof idType)}>
            <option value="email">E-mail address</option>
            <option value="user_id">User id</option>
            <option value="profile_id">Profile id</option>
          </Select>
        </Field>
        <Field label="People" hint="One per line. Up to 1,000. Adding someone twice changes nothing.">
          <textarea
            className="min-h-32 w-full rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-[12px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={idType === 'email' ? 'ada@example.com\nbo@example.com' : idType === 'user_id' ? 'ada\nbo' : 'prf_…'}
          />
        </Field>
        <p className="text-[12px] text-muted">{values.length} entered.</p>
        {error && <Alert tone={unmatched.length ? 'warn' : 'bad'}>{error}</Alert>}
        {unmatched.length > 0 && (
          <ul className="max-h-40 overflow-auto rounded-md border border-line p-2 text-[12px]">
            {unmatched.map((u, i) => (
              <li key={`${u.value}-${i}`}>
                {u.value} — {u.reason.replace('_', ' ')}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function ImportDialog({ artifactId, onClose, onDone }: { artifactId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [column, setColumn] = useState('');
  const [idType, setIdType] = useState<'email' | 'user_id' | 'profile_id'>('email');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => (csv ? parseCsv(csv) : []), [csv]);
  const headers = parsed[0] ?? [];

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    if (file.size > 5 * 1024 * 1024) return setError('The file is larger than 5 MB.');
    setFileName(file.name);
    setCsv(await file.text());
    setColumn('');
  };

  const run = async (dryRun: boolean) => {
    if (!column) return setError('Choose the column that holds the identifier.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('audiences.import', { segmentId: artifactId, csv, column, idType, fileName, dryRun });
      setPreview(r);
      if (!dryRun) {
        toast.success(`Imported: ${r.added} added, ${r.existing} already on the list, ${r.unmatched.length} unmatched.`);
        onDone();
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Import a CSV"
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          {preview && (
            <Button variant="primary" loading={busy} onClick={() => void run(false)}>
              Apply {preview.added} {preview.added === 1 ? 'addition' : 'additions'}
            </Button>
          )}
          {!preview && (
            <Button variant="primary" loading={busy} disabled={!csv} onClick={() => void run(true)}>
              Preview matches
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="CSV file" hint="Up to 5 MB, with a header row. UTF-8, comma, semicolon or tab.">
          <input type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} />
        </Field>
        {fileName && <p className="text-[12px] text-muted">{fileName}</p>}

        {headers.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Column with the identifier">
              <Select
                value={column}
                onChange={(e) => {
                  setColumn(e.target.value);
                  setPreview(null);
                }}
              >
                <option value="">Choose a column…</option>
                {headers.map((h, i) => (
                  <option key={`${h}-${i}`} value={h}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Identify people by">
              <Select
                value={idType}
                onChange={(e) => {
                  setIdType(e.target.value as typeof idType);
                  setPreview(null);
                }}
              >
                <option value="email">E-mail address</option>
                <option value="user_id">User id</option>
                <option value="profile_id">Profile id</option>
              </Select>
            </Field>
          </div>
        )}

        {error && <Alert tone="bad">{error}</Alert>}

        {preview && (
          <div className="space-y-3 rounded-md border border-line p-3">
            <p className="text-[13px]">
              <strong>{preview.rows}</strong> rows: <strong>{preview.matched}</strong> matched, <strong>{preview.added}</strong> would be
              added, <strong>{preview.existing}</strong> already on the list, <strong>{preview.unmatched.length}</strong> unmatched.
            </p>
            <PreviewRows parsed={parsed} column={column} unmatched={preview.unmatched} />
            {preview.unmatched.length > 0 && (
              <div>
                <p className="mb-1 text-[12px] font-medium text-fg">Unmatched rows</p>
                <ul className="max-h-40 overflow-auto text-[12px] text-muted">
                  {preview.unmatched.slice(0, 50).map((u) => (
                    <li key={u.row}>
                      Row {u.row}: {u.reason.replace('_', ' ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The first few rows with their match outcome, so the mapping can be checked before applying. */
function PreviewRows({ parsed, column, unmatched }: { parsed: string[][]; column: string; unmatched: Unmatched[] }) {
  const index = parsed[0]?.findIndex((h) => h.trim().toLowerCase() === column.trim().toLowerCase()) ?? -1;
  if (index < 0) return null;
  const reasons = new Map(unmatched.map((u) => [u.row, u.reason]));
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 font-medium">Row</th>
          <th className="py-1 font-medium">Value</th>
          <th className="py-1 font-medium">Match</th>
        </tr>
      </thead>
      <tbody>
        {parsed.slice(1, 6).map((row, i) => {
          const reason = reasons.get(i + 2);
          return (
            <tr key={i}>
              <td className="py-1">{i + 2}</td>
              <td className="py-1 font-mono">{row[index] ?? ''}</td>
              <td className={reason ? 'py-1 text-warn' : 'py-1 text-good'}>{reason ? reason.replace('_', ' ') : 'matched'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface SegmentContent {
  description?: string;
  mode?: 'dynamic' | 'static' | 'snapshot';
  condition?: unknown;
  sourceSegment?: string;
  snapshotAt?: string;
  snapshotVersion?: number;
  [key: string]: unknown;
}
