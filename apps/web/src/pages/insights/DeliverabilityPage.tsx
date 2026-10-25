import { Gauge, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Mono,
  PageHeader,
  StatusPill,
  Tag,
  formatDateTime,
} from '../../ui';

type Health = Out<'deliverability.health'>;
type Rates = Health['email']['marketing'];
type Report = Out<'emailProviders.checkDomain'>;
type Check = { loading: boolean; report?: Report; error?: string; checkedAt?: string };

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const rateTone = { ok: 'good', warn: 'warn', paused: 'bad' } as const;

/** Bounce and complaint rates, and the DNS records behind every sending domain. */
export default function DeliverabilityPage() {
  useCrumbs([{ label: 'Deliverability' }]);
  const { can } = useSession();
  const admin = can('workspace:admin');
  const [selectors, setSelectors] = useState('');
  const [checks, setChecks] = useState<Record<string, Check>>({});

  const health = useApi(() => api.call('deliverability.health', {}), []);
  const providers = useApi(() => api.call('emailProviders.list', {}), [], { skip: !admin });

  const runCheck = async (id: string) => {
    const list = selectors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
    setChecks((c) => ({ ...c, [id]: { loading: true } }));
    try {
      const report = await api.call('emailProviders.checkDomain', { id, dkimSelectors: list });
      setChecks((c) => ({ ...c, [id]: { loading: false, report, checkedAt: new Date().toISOString() } }));
    } catch (e) {
      setChecks((c) => ({ ...c, [id]: { loading: false, error: errText(e) } }));
    }
  };

  const h = health.data;
  return (
    <div>
      <PageHeader
        title="Deliverability"
        description="Are sends landing, and are the sending domains set up correctly? Marketing pauses itself when complaints or bounces pass the policy thresholds."
      />

      <div className="space-y-5">
        <Card
          title={h ? `Bounce and complaint rates · last ${h.windowDays} days` : 'Bounce and complaint rates'}
          action={<Gauge size={15} className="text-muted" aria-hidden />}
        >
          {health.loading ? (
            <LoadingBlock lines={4} label="Loading deliverability" />
          ) : health.error ? (
            <div className="p-3">
              <Alert tone="bad" title="Couldn't load the health summary" onRetry={health.reload}>
                {health.error}
              </Alert>
            </div>
          ) : h ? (
            <>
              <div className="divide-y divide-line">
                <Stream label="E-mail · marketing" rates={h.email.marketing} />
                <Stream label="E-mail · transactional" rates={h.email.transactional} />
                <Stream label="SMS · marketing" rates={h.sms.marketing} />
                <Stream label="SMS · transactional" rates={h.sms.transactional} />
              </div>
              <p className="border-t border-line px-4 py-2.5 text-[12px] text-muted">
                Marketing messages pause at {pct(h.thresholds.complaintStop)} complaints or {pct(h.thresholds.bounceStop)} bounces, after{' '}
                {h.thresholds.minVolume.toLocaleString()} messages.
                {h.autoPause ? '' : ' Auto-pause is off, so these are warnings only.'} Caps and quiet hours live in the delivery policy artifact.
              </p>
            </>
          ) : null}
        </Card>

        <section aria-labelledby="domains-heading">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="domains-heading" className="flex items-center gap-1.5 text-[14px] font-semibold">
                <ShieldCheck size={15} className="text-muted" aria-hidden />
                Sending domains
              </h2>
              <p className="mt-0.5 text-[12px] text-muted">SPF, DKIM and DMARC per provider, with the record to add when one is missing.</p>
            </div>
          </div>

          {!admin ? (
            <Alert tone="info">
              Domain checks need the e-mail provider settings, which require <Mono>workspace:admin</Mono>. Ask a workspace admin to check the sending
              domains.
            </Alert>
          ) : (
            <>
              <Field
                label="DKIM selectors"
                hint="Comma-separated selectors from the provider's DNS settings (up to 5). Leave empty to check SPF and DMARC only."
                className="mb-3 max-w-[520px]"
              >
                <Input
                  value={selectors}
                  onChange={(e) => setSelectors(e.target.value)}
                  placeholder="selector1, selector2"
                  autoComplete="off"
                />
              </Field>

              {providers.loading ? (
                <LoadingBlock lines={3} label="Loading e-mail providers" />
              ) : providers.error ? (
                <Alert tone="bad" title="Couldn't load the e-mail providers" onRetry={providers.reload}>
                  {providers.error}
                </Alert>
              ) : (providers.data?.providers.length ?? 0) === 0 ? (
                <div className="rounded-lg border border-line bg-surface">
                  <EmptyState
                    title="No sending providers yet"
                    action={<ButtonLink to="/settings/providers" variant="primary">Add a provider</ButtonLink>}
                  >
                    Add an e-mail provider under Settings → Providers, then check its sending domain here.
                  </EmptyState>
                </div>
              ) : (
                <div className="space-y-3">
                  {providers.data?.providers.map((p) => {
                    const check = checks[p.id];
                    return (
                      <Card
                        key={p.id}
                        title={p.name}
                        description={
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Mono className="bg-transparent px-0">{p.fromEmail}</Mono>
                            <span>{p.adapter}</span>
                            {p.useFor.map((u) => (
                              <Tag key={u}>{u}</Tag>
                            ))}
                            {!p.enabled && <StatusPill tone="neutral">Disabled</StatusPill>}
                          </span>
                        }
                        action={
                          <Button size="sm" loading={check?.loading} onClick={() => void runCheck(p.id)}>
                            Check domain
                          </Button>
                        }
                      >
                        <div className="p-4">
                          {!check ? (
                            <p className="text-[13px] text-muted">Run a check to look up SPF, DKIM and DMARC for this domain.</p>
                          ) : check.error ? (
                            <Alert tone="bad">{check.error}</Alert>
                          ) : check.report ? (
                            <DomainReportView report={check.report} checkedAt={check.checkedAt} />
                          ) : (
                            <LoadingBlock lines={3} label="Checking DNS" />
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Stream({ label, rates }: { label: string; rates: Rates }) {
  return (
    <div className="px-4 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium">{label}</span>
        <StatusPill tone={rateTone[rates.status]}>{rates.status}</StatusPill>
      </div>
      <div className="mt-0.5 text-[12px] text-muted tabular-nums">
        {rates.sent.toLocaleString()} sent · bounces {pct(rates.bounceRate)} · complaints {pct(rates.complaintRate)}
      </div>
      {rates.reason && <p className="mt-0.5 text-[12px] text-warn">{rates.reason}</p>}
    </div>
  );
}

function DomainReportView({ report, checkedAt }: { report: Report; checkedAt?: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={report.ok ? 'good' : 'bad'}>{report.ok ? 'Domain passes' : 'Needs attention'}</StatusPill>
        <span className="text-[12px] text-muted">
          {checkedAt ? `Checked ${formatDateTime(checkedAt)}` : 'Checked just now'} · {report.domain}
        </span>
      </div>
      <dl className="space-y-3 text-[13px]">
        <CheckRow name="SPF" ok={report.spf.ok} record={report.spf.record} advice={report.spf.advice} />
        {report.dkim.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-muted">
            <dt className="w-[92px] shrink-0 font-medium">DKIM</dt>
            <dd>No selectors given. Add the selectors from the provider's DNS settings and check again.</dd>
          </div>
        ) : (
          report.dkim.map((d) => <CheckRow key={d.selector} name={`DKIM · ${d.selector}`} ok={d.ok} record={d.record} advice={d.ok ? null : `Publish the DKIM record at ${d.selector}._domainkey.${report.domain}.`} />)
        )}
        <CheckRow
          name="DMARC"
          ok={report.dmarc.ok}
          record={report.dmarc.record}
          advice={report.dmarc.advice}
          detail={report.dmarc.policy ? `policy ${report.dmarc.policy}` : undefined}
        />
      </dl>
    </div>
  );
}

function CheckRow({ name, ok, record, advice, detail }: { name: string; ok: boolean; record: string | null; advice: string | null; detail?: string }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
      <dt className="w-[92px] shrink-0 pt-0.5 font-medium">{name}</dt>
      <dd className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <StatusPill tone={ok ? 'good' : 'bad'}>{ok ? 'Pass' : 'Fail'}</StatusPill>
          {detail && <span className="text-[12px] text-muted">{detail}</span>}
        </span>
        {record ? (
          <Mono className="block max-w-full break-all whitespace-pre-wrap">{record}</Mono>
        ) : (
          <span className="text-[12px] text-muted">No record found.</span>
        )}
        {advice && <p className="text-[12px] text-warn">{advice}</p>}
      </dd>
    </div>
  );
}
