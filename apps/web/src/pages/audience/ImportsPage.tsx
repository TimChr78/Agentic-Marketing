import { Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { guessMapping, type Mapping, parseCsv, toImportRows } from '../../lib/csvImport';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  formatDateTime,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
  useToast,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

type ConsentStatus = 'granted' | 'denied' | 'withdrawn' | 'objected';
type Result = { accepted: number; rejected: { email: string; error: string }[] };

const BATCH = 5000;
const FIELDS: [keyof Mapping, string][] = [
  ['email', 'E-mail'],
  ['firstName', 'First name'],
  ['subscribedAt', 'Subscribed at'],
  ['status', 'Status'],
];

/** Import subscribers from a CSV export (Kit, Mailchimp…) with their consent and proof. */
export default function ImportsPage() {
  useCrumbs([{ label: 'Imports' }]);
  const { can } = useSession();
  const toast = useToast();
  const canImport = can('profiles:write');
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [label, setLabel] = useState(`Kit export ${new Date().toISOString().slice(0, 10)}`);
  const [system, setSystem] = useState('Kit');
  const [purpose, setPurpose] = useState('marketing_email');
  const [status, setStatus] = useState<ConsentStatus>('granted');
  const [activeOnly, setActiveOnly] = useState(true);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const purposes = useApi(() => api.call('purposes.list', {}), [], { skip: !can('artifacts:read') });
  const prepared = useMemo(
    () => (mapping && rows.length > 0 && mapping.email >= 0 ? toImportRows(rows, mapping, { purpose, system, activeOnly }) : null),
    [rows, mapping, purpose, system, activeOnly],
  );
  const payload = useMemo(
    () =>
      prepared?.rows.map((r) => ({
        ...r,
        consent: r.consent.map((c) => ({ ...c, status })),
      })) ?? [],
    [prepared, status],
  );
  const preview = payload.slice(0, 5);
  const skipped = prepared?.skipped ?? [];
  const skippedByReason = skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {});

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseCsv(await file.text());
    setRows(parsed);
    setMapping(parsed.length ? guessMapping(parsed[0]) : null);
    setResult(null);
    setError(null);
  };

  const readPaste = () => {
    const parsed = parseCsv(paste);
    setRows(parsed);
    setMapping(parsed.length ? guessMapping(parsed[0]) : null);
    setResult(null);
    setError(null);
  };

  const runImport = async () => {
    if (!prepared || !payload.length) return;
    if (!label.trim()) {
      setError('Give this import a label so the proof can be traced back.');
      return;
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(purpose)) {
      setError('The purpose must be a lowercase key such as marketing_email.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    const rejected: Result['rejected'] = [];
    let accepted = 0;
    try {
      for (let i = 0; i < payload.length; i += BATCH) {
        const r = await api.call('profiles.import', { label: label.trim(), rows: payload.slice(i, i + BATCH) });
        accepted += r.accepted;
        for (const x of r.rejected) rejected.push({ email: payload[i + x.index]?.email ?? 'row', error: x.error });
      }
      setResult({ accepted, rejected });
      if (accepted > 0)
        toast.success(
          `Imported ${accepted.toLocaleString()} ${accepted === 1 ? 'person' : 'people'}. Profiles and consent appear within seconds.`,
        );
      else toast.error('Nothing was imported. Fix the rejected rows and try again.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={pageWidth('reading')}>
      <PageHeader
        title="Imports"
        description="Bring in subscribers from another tool with the consent they gave there. Only people can import consent, and every row keeps its evidence."
      />

      <Alert tone="info" className="mb-5">
        Each row keeps its purpose, old system, subscription date and status as consent proof, together with this import's label and the
        person who ran it. Only import people who agreed to receive e-mail.
      </Alert>

      <div className="space-y-5">
        <Card
          title="Choose a file"
          description="A CSV export from Kit, Mailchimp or a similar tool. The first row must contain the column names."
          padded
        >
          <div className="space-y-4">
            <Field label="CSV file" hint="Comma, semicolon and tab separated files are read.">
              <Input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  void readFile(e.target.files?.[0]);
                }}
              />
            </Field>
            <div className="border-t border-line pt-4">
              <Field label="Or paste the CSV" hint="Paste the whole export, including the header row.">
                <Textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  rows={4}
                  mono
                  placeholder="email_address,first_name,state,created_at"
                />
              </Field>
              <Button className="mt-2" onClick={readPaste} disabled={!paste.trim()}>
                Use pasted CSV
              </Button>
            </div>
          </div>
        </Card>

        {mapping && rows.length > 0 && (
          <>
            <Card title="Map the columns" description={`${(rows.length - 1).toLocaleString()} data rows found.`} padded>
              <div className="grid gap-4 sm:grid-cols-2">
                {FIELDS.map(([key, name]) => (
                  <Field key={key} label={name} hint={key === 'email' ? 'Required. Each row needs a valid address.' : undefined}>
                    <Select value={mapping[key]} onChange={(e) => setMapping({ ...mapping, [key]: Number(e.target.value) })}>
                      <option value={-1}>(not in the file)</option>
                      {rows[0].map((h, i) => (
                        <option key={`${h}-${i}`} value={i}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>
              {mapping.email < 0 && (
                <Alert tone="warn" className="mt-4">
                  Choose the column that holds the e-mail address before importing.
                </Alert>
              )}
            </Card>

            <Card title="Consent and proof" description="What each imported person agreed to, and where that evidence comes from." padded>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Import label" hint="Kept with every row; make it recognisable later." required>
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
                </Field>
                <Field label="Old system" hint="The tool the export came from, kept in the proof.">
                  <Input value={system} onChange={(e) => setSystem(e.target.value)} maxLength={80} />
                </Field>
                <Field label="Purpose" hint="What these people agreed to receive." required>
                  {purposes.data?.purposes.length ? (
                    <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                      {purposes.data.purposes.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name} ({p.key})
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} autoComplete="off" />
                  )}
                </Field>
                <Field label="Consent status" hint="Most exports are granted; withdrawn and objected record opt-outs.">
                  <Select value={status} onChange={(e) => setStatus(e.target.value as ConsentStatus)}>
                    <option value="granted">Granted</option>
                    <option value="denied">Denied</option>
                    <option value="withdrawn">Withdrawn</option>
                    <option value="objected">Objected</option>
                  </Select>
                </Field>
              </div>
              <Checkbox
                className="mt-4"
                label="Only people whose status is active, confirmed or subscribed"
                hint="Uses the mapped status column. Leave on to skip unsubscribed and bounced addresses."
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
              />
            </Card>

            {prepared && (
              <Card
                title="Preview"
                description={
                  <>
                    {payload.length.toLocaleString()} to import
                    {skipped.length > 0 && `, ${skipped.length.toLocaleString()} skipped`}
                    {skipped.length > 0 &&
                      ` (${Object.entries(skippedByReason)
                        .map(([r, n]) => `${n.toLocaleString()} ${r}`)
                        .join(', ')})`}
                    .
                  </>
                }
              >
                {preview.length > 0 ? (
                  <div className="overflow-x-auto">
                    <Table label="Rows to import">
                      <THead>
                        <tr>
                          <Th>E-mail</Th>
                          <Th className="hidden md:table-cell">First name</Th>
                          <Th>Consent</Th>
                          <Th className="hidden lg:table-cell">Subscribed at</Th>
                          <Th className="hidden xl:table-cell">Proof kept</Th>
                        </tr>
                      </THead>
                      <tbody>
                        {preview.map((r) => (
                          <Tr key={r.email}>
                            <Td className="break-all font-medium text-fg">{r.email}</Td>
                            <Td className="hidden md:table-cell">{r.traits.firstName ?? '—'}</Td>
                            <Td>
                              {r.consent[0]?.status ?? 'none'} · {r.consent[0]?.purpose ?? purpose}
                            </Td>
                            <Td className="hidden lg:table-cell">
                              {r.consent[0]?.recordedAt ? (
                                formatDateTime(r.consent[0].recordedAt)
                              ) : (
                                <span className="text-muted">Not in the file</span>
                              )}
                            </Td>
                            <Td className="hidden max-w-[360px] xl:table-cell">
                              <span className="line-clamp-2 text-[12px] text-muted">
                                {Object.entries(r.consent[0]?.proof ?? {})
                                  .map(([k, v]) => `${k}: ${String(v)}`)
                                  .join(' · ')}
                              </span>
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                ) : (
                  <div className="p-4 text-[13px] text-muted">
                    No rows can be imported with this mapping. Check the e-mail column and the status filter.
                  </div>
                )}
              </Card>
            )}

            {error && <Alert tone="bad">{error}</Alert>}

            {result && (
              <Alert
                tone={result.accepted > 0 ? 'good' : 'warn'}
                title={`Imported ${result.accepted.toLocaleString()} ${result.accepted === 1 ? 'person' : 'people'}`}
              >
                {result.rejected.length > 0 && (
                  <>
                    <p className="mt-0.5">{result.rejected.length.toLocaleString()} rejected by the server:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {result.rejected.slice(0, 5).map((r) => (
                        <li key={`${r.email}-${r.error}`}>
                          {r.email}: {r.error}
                        </li>
                      ))}
                      {result.rejected.length > 5 && <li>…and {result.rejected.length - 5} more</li>}
                    </ul>
                  </>
                )}
                <p className="mt-1">Profiles and consent appear within seconds; refresh People to see them.</p>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={<Upload size={15} />}
                loading={busy}
                disabled={!canImport || !payload.length || mapping.email < 0}
                onClick={runImport}
              >
                Import {payload.length.toLocaleString()} {payload.length === 1 ? 'person' : 'people'}
              </Button>
              <span className="text-[12px] text-muted">
                {canImport ? 'Up to 5,000 rows per call; larger files are sent in batches.' : 'Your role cannot import people.'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
