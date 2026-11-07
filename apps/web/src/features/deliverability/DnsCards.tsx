import { ShieldCheck } from 'lucide-react';
import type { Out } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { Alert, Button, EmptyState, Field, Input, LoadingBlock, Mono, StatusPill, Tag } from '../../ui';
import { CopyRecord } from './CopyRecord';
import { checkFix, type DnsOverall, dkimFix, dnsOverall, formatMoment, isNotFound, type Report, recordsUnavailableCopy } from './model';

// Sending-domain checks (#508) as cards. Each failed check carries the fix beside it: the server's
// advice when supplied, otherwise a neutral instruction to ask the DNS administrator. Only supplied
// records are shown or copied; no TXT value is generated.

function CheckBlock({
  label,
  ok,
  record,
  advice,
  detail,
  fallbackFix,
  recordName,
}: {
  label: string;
  ok: boolean;
  record: string | null;
  advice: string | null;
  detail?: string;
  fallbackFix: string;
  recordName: string;
}) {
  return (
    <div className="min-w-0 space-y-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        <StatusPill tone={ok ? 'good' : 'warn'}>{ok ? 'Pass' : 'Needs attention'}</StatusPill>
        {detail && <span className="text-[12px] text-muted">{detail}</span>}
      </div>
      {record ? (
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <Mono className="min-w-0 max-w-full break-all whitespace-pre-wrap">{record}</Mono>
          <CopyRecord value={record} name={`${recordName} record`} />
        </div>
      ) : (
        <p className="text-[12px] leading-[18px] text-muted">No record found. {recordsUnavailableCopy()}</p>
      )}
      {!ok && (
        <p className="break-words text-[12px] leading-[18px] text-warn">
          <span className="font-medium">Fix:</span> {checkFix(advice, fallbackFix)}
        </p>
      )}
      {ok && advice && (
        <p className="break-words text-[12px] leading-[18px] text-fg-2">
          <span className="font-medium">Advice:</span> {advice}
        </p>
      )}
    </div>
  );
}

function DomainCard({ report, checkedAt }: { report: Report; checkedAt: string }) {
  const overall: DnsOverall = dnsOverall(report);
  return (
    <article aria-label={`Sending domain ${report.domain}`} className="min-w-0 rounded-lg border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-[15px] leading-6 font-semibold">{report.domain}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {report.uses.map((use) => (
              <Tag key={use}>{use}</Tag>
            ))}
          </div>
        </div>
        <StatusPill tone={overall.tone}>{overall.label}</StatusPill>
      </div>
      <p className="mt-2 text-[12px] leading-[18px] text-muted">
        Checked {formatMoment(checkedAt)}. {recordsUnavailableCopy()}
      </p>

      <div className="mt-3 space-y-3">
        <CheckBlock
          label="SPF"
          ok={report.spf.ok}
          record={report.spf.record}
          advice={report.spf.advice}
          fallbackFix="Ask your DNS administrator to verify the provider’s SPF record."
          recordName="SPF"
        />

        {report.dkim.length === 0 ? (
          <div className="space-y-1.5 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-fg">DKIM</span>
              <StatusPill tone="neutral">DKIM not checked</StatusPill>
            </div>
            <p className="text-[12px] leading-[18px] text-muted">Supply the selectors your provider uses.</p>
          </div>
        ) : (
          report.dkim.map((selector) => (
            <CheckBlock
              key={selector.selector}
              label={`DKIM · ${selector.selector}`}
              ok={selector.ok}
              record={selector.record}
              advice={null}
              fallbackFix={dkimFix()}
              recordName={`DKIM ${selector.selector}`}
            />
          ))
        )}

        <CheckBlock
          label="DMARC"
          ok={report.dmarc.ok}
          record={report.dmarc.record}
          advice={report.dmarc.advice}
          detail={report.dmarc.policy ? `policy ${report.dmarc.policy}` : 'policy missing'}
          fallbackFix="Ask your DNS administrator to publish a DMARC policy for this domain."
          recordName="DMARC"
        />
      </div>
    </article>
  );
}

export type Domains = Out<'sendingDomains.list'>;

export function DnsSection({
  data,
  loading,
  error,
  onRetry,
  refreshing,
  admin,
  selectors,
  onSelectorsChange,
  onCheck,
}: {
  data: Domains | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  refreshing: boolean;
  admin: boolean;
  selectors: string;
  onSelectorsChange: (value: string) => void;
  onCheck: () => void;
}) {
  return (
    <section aria-labelledby="domains-heading" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="domains-heading" className="flex items-center gap-1.5 text-[16px] leading-6 font-semibold">
            <ShieldCheck size={16} className="text-muted" aria-hidden />
            Sending domain checks
          </h2>
          <p className="mt-0.5 max-w-[760px] text-[12px] leading-[18px] text-muted">
            SPF, DKIM and DMARC for the domains enabled providers send from. A failed check shows the fix beside it; no DNS record is
            invented.
          </p>
        </div>
        {data && <span className="text-[12px] leading-[18px] text-muted">Last checked {formatMoment(data.checkedAt)}</span>}
      </div>

      <Field
        label="DKIM selectors"
        hint="Comma-separated selectors from the provider’s DNS settings. Up to five unique selectors; leave empty to check SPF and DMARC only."
        className="max-w-[560px]"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={selectors}
            onChange={(event) => onSelectorsChange(event.target.value)}
            placeholder="selector1, selector2"
            autoComplete="off"
            className="min-w-0 flex-1"
          />
          <Button size="sm" loading={refreshing} onClick={onCheck}>
            Check DNS
          </Button>
        </div>
      </Field>

      {loading ? (
        <div aria-busy="true">
          <LoadingBlock lines={5} label="Checking sending domains" />
        </div>
      ) : error ? (
        isNotFound(error) ? (
          <Alert tone="warn" title="This item is not available at this address">
            Return to the deliverability page from the workspace navigation.
          </Alert>
        ) : (
          <Alert tone="bad" title="DNS checks unavailable" onRetry={onRetry}>
            {error}. Retry DNS independently; successful rates remain visible.
          </Alert>
        )
      ) : !data || data.domains.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            title="No sending domains yet"
            action={
              admin && (
                <ButtonLink to="/settings/providers" variant="primary">
                  Configure sending domain
                </ButtonLink>
              )
            }
          >
            {admin
              ? 'Add an e-mail provider under Settings → Providers, then check its sending domain here.'
              : 'No enabled e-mail provider has a sending domain yet. Ask a workspace administrator to configure one under Settings → Providers.'}
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.domains.map((report) => (
            <DomainCard key={report.domain} report={report} checkedAt={data.checkedAt} />
          ))}
        </div>
      )}
    </section>
  );
}
