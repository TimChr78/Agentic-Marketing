import { useState } from 'react';
import { Upload } from 'lucide-react';
import { Button, Card, cx, inputCls } from '../../components/ui';
import { guessMapping, type Mapping, parseCsv, toImportRows } from '../../lib/csvImport';
import { api, errText } from '../liveApi';

// Import subscribers from a CSV export (Kit, Mailchimp…) with their consent and proof. Runs as the
// signed-in person: importing consent is never something an agent may do.

const BATCH = 5000;
const FIELDS: [keyof Mapping, string][] = [
  ['email', 'E-mail'],
  ['firstName', 'First name'],
  ['subscribedAt', 'Subscribed at'],
  ['status', 'Status'],
];

export function LiveImport({ onError, onDone }: { onError: (m: string) => void; onDone: () => void }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [system, setSystem] = useState('Kit');
  const [purpose, setPurpose] = useState('marketing_email');
  const [activeOnly, setActiveOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const prepared = mapping && mapping.email >= 0 ? toImportRows(rows, mapping, { purpose, system, activeOnly }) : null;

  return (
    <Card title="Import subscribers">
      <div className="space-y-2 p-3 text-[13px]">
        <p className="text-[12px] text-muted">
          A CSV export from Kit, Mailchimp or similar. Each row keeps its subscription date and source as consent proof. Only import people who agreed to receive e-mail.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          className="block w-full text-[12px]"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const parsed = parseCsv(await f.text());
            setRows(parsed);
            setMapping(parsed.length ? guessMapping(parsed[0]) : null);
            setResult('');
          }}
        />
        {mapping && rows.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {FIELDS.map(([key, label]) => (
                <label key={key} className="text-[12px] text-muted">
                  {label}
                  <select className={inputCls} value={mapping[key]} onChange={(e) => setMapping({ ...mapping, [key]: Number(e.target.value) })}>
                    <option value={-1}>(none)</option>
                    {rows[0].map((h, i) => (
                      <option key={`${h}-${i}`} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="text-[12px] text-muted">
                Old system (proof)
                <input className={inputCls} value={system} onChange={(e) => setSystem(e.target.value)} />
              </label>
              <label className="text-[12px] text-muted">
                Purpose
                <input className={inputCls} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              </label>
            </div>
            <label className="flex items-center gap-1.5 text-[12px]">
              <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Only active subscribers (status active,
              confirmed or subscribed)
            </label>
            {prepared && (
              <p className={cx('text-[12px]', prepared.rows.length ? '' : 'text-bad')}>
                {prepared.rows.length} to import, {prepared.skipped.length} skipped
                {prepared.skipped.length
                  ? ` (${Object.entries(
                      prepared.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {}),
                    )
                      .map(([r, n]) => `${n} ${r}`)
                      .join(', ')})`
                  : ''}
              </p>
            )}
            <Button
              variant="primary"
              disabled={busy || !prepared?.rows.length}
              onClick={async () => {
                if (!prepared) return;
                setBusy(true);
                try {
                  const label = `${system} export ${new Date().toISOString().slice(0, 10)}`;
                  let accepted = 0;
                  const rejected: string[] = [];
                  for (let i = 0; i < prepared.rows.length; i += BATCH) {
                    const r = await api.call('profiles.import', { label, rows: prepared.rows.slice(i, i + BATCH) });
                    accepted += r.accepted;
                    for (const x of r.rejected) rejected.push(`${prepared.rows[i + x.index].email}: ${x.error}`);
                  }
                  setResult(`Imported ${accepted}.${rejected.length ? ` Rejected: ${rejected.slice(0, 5).join('; ')}${rejected.length > 5 ? '…' : ''}` : ''}`);
                  onError('');
                  onDone();
                } catch (err) {
                  onError(errText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Upload size={14} /> {busy ? 'Importing…' : 'Import'}
            </Button>
            {result && <p className="text-[12px] text-good">{result} Profiles and consent appear within seconds.</p>}
          </>
        )}
      </div>
    </Card>
  );
}
