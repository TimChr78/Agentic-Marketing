import { Check } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { Link } from '../../app/router';
import { Button } from '../../ui/Button';
import { cx } from '../../ui/cx';
import { StatusPill } from '../../ui/display';
import { formatDateTime } from '../../ui/time';
import { CHECKLIST_CONFIRMED, CHECKLIST_STATE, type ChecklistCheck, type ChecklistKey, type ChecklistView } from './checklist';
import { HomeSection } from './HomeSection';

// The checklist is a read-only view of current configuration (#447). Rows are links only while
// incomplete; completed rows are facts, never checkboxes. The sending-DNS disclosure is a separate
// advisory and never changes the four required checks.

const COPY: Record<ChecklistKey, { label: string; incomplete: string }> = {
  brand: { label: 'Publish your brand', incomplete: 'Add a brand and publish a version.' },
  email: { label: 'Configure marketing e-mail', incomplete: 'Choose a provider before sending e-mail.' },
  domain: { label: 'Set up a link domain', incomplete: 'Verify the primary domain for subscriber links.' },
  audience: { label: 'Add your audience', incomplete: 'Import people with their consent records.' },
};

const ORDER: ChecklistKey[] = ['brand', 'email', 'domain', 'audience'];

function destinationOf(key: ChecklistKey, can: (permission: string) => boolean): string | null {
  switch (key) {
    case 'brand':
      return can('artifacts:read') ? '/content/brand' : null;
    case 'email':
      return can('workspace:admin') ? '/settings/providers' : null;
    case 'domain':
      return can('workspace:admin') ? '/settings/workspace' : null;
    case 'audience':
      if (can('profiles:write')) return '/audience/people?tab=imports';
      return can('profiles:read') ? '/audience/people' : null;
  }
}

function CheckRow({
  itemKey,
  check,
  can,
  linksUrl,
  onRetry,
}: {
  itemKey: ChecklistKey;
  check: ChecklistCheck;
  can: (permission: string) => boolean;
  linksUrl: string;
  onRetry: () => void;
}) {
  const copy = COPY[itemKey];
  const destination = check.status === 'incomplete' ? destinationOf(itemKey, can) : null;
  const state = check.status === 'confirmed' ? CHECKLIST_CONFIRMED : CHECKLIST_STATE[check.status];
  const detail =
    check.status === 'confirmed'
      ? `${check.detail ?? copy.label} · Confirmed from current configuration`
      : check.status === 'incomplete'
        ? copy.incomplete
        : check.status === 'checking'
          ? 'Checking the current configuration.'
          : (check.reason ?? '');
  return (
    <li className="flex min-h-16 flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        {check.status === 'confirmed' ? (
          <p className="flex items-start gap-1.5 text-[13px] leading-5 font-medium">
            <Check size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-good" aria-hidden />
            <span className="break-words">{copy.label}</span>
          </p>
        ) : destination ? (
          <Link to={destination} className="text-[13px] leading-5 font-medium text-accent hover:underline">
            {copy.label}
          </Link>
        ) : (
          <p className="text-[13px] leading-5 font-medium break-words">{copy.label}</p>
        )}
        <p className={cx('mt-1 text-[12px] leading-[18px]', check.status === 'failed' ? 'text-bad' : 'text-muted')}>{detail}</p>
        {itemKey === 'domain' && linksUrl && (
          <p className="mt-1 text-[12px] leading-[18px] break-all text-muted">Effective links URL: {linksUrl}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {check.status === 'failed' && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        )}
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
      </div>
    </li>
  );
}

function SendingDnsAdvisory() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Out<'sendingDomains.list'> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.call('sendingDomains.list', { dkimSelectors: [] }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && data === undefined && !loading && error === null) void load();
  }, [open, data, loading, error, load]);

  return (
    <div className="mt-2 border-t border-line pt-3">
      <details
        onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
        open={open}
        className="text-[13px] leading-5"
      >
        <summary className="flex min-h-10 cursor-pointer items-center text-accent pointer-coarse:min-h-10 md:min-h-0">
          Review sending DNS
        </summary>
        <div className="mt-2 space-y-2 text-[12px] leading-[18px] text-fg-2">
          <p className="text-muted">
            This is advisory and does not block setup. It checks the domains the enabled e-mail providers send from.
          </p>
          {loading && <p role="status">Checking sending DNS…</p>}
          {error && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-bad">Couldn't check sending DNS: {error}</p>
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          )}
          {data && (
            <>
              <p className="text-muted">Checked {formatDateTime(data.checkedAt, { zone: true })}</p>
              {data.domains.length === 0 ? (
                <p>No sending domains are configured.</p>
              ) : (
                <ul className="space-y-2">
                  {data.domains.map((domain) => (
                    <li key={domain.domain} className="break-words">
                      <span className="font-medium">{domain.domain}</span>
                      <span className="block text-muted">
                        SPF {domain.spf.ok ? 'present' : 'missing'} · DMARC{' '}
                        {domain.dmarc.ok ? `present${domain.dmarc.policy ? ` (p=${domain.dmarc.policy})` : ''}` : 'missing'} · DKIM not
                        checked (no selectors)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-muted">DKIM is unverified without the provider’s selectors.</p>
            </>
          )}
          <p>
            <Link to="/insights/deliverability" className="text-accent hover:underline">
              Open Deliverability
            </Link>
          </p>
        </div>
      </details>
    </div>
  );
}

export function OnboardingChecklist({
  brandName,
  view,
  can,
  linksUrl,
  readOnly,
  onHide,
  onClose,
  onRetry,
}: {
  brandName: string;
  view: ChecklistView;
  can: (permission: string) => boolean;
  linksUrl: string;
  readOnly: boolean;
  onHide: () => void;
  onClose: () => void;
  onRetry: { brand: () => void; status: () => void; profiles: () => void };
}) {
  const retryFor = (key: ChecklistKey) => (key === 'audience' ? onRetry.profiles : key === 'email' ? onRetry.status : onRetry.brand);
  return (
    <HomeSection
      title={`Set up ${brandName}`}
      action={
        <Button size="sm" variant="ghost" onClick={readOnly ? onClose : onHide}>
          {readOnly ? 'Close' : 'Hide setup checklist'}
        </Button>
      }
    >
      <div className="px-4 py-4 md:px-5">
        {readOnly && (
          <p className="mb-2 flex items-center gap-1.5 text-[13px] leading-5 font-medium text-good">
            <Check size={16} strokeWidth={1.75} aria-hidden /> Setup confirmed
          </p>
        )}
        <p className="text-[12px] leading-[18px] text-muted">{view.confirmed} of 4 confirmed · based on current configuration</p>
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {ORDER.map((key) => (
            <CheckRow key={key} itemKey={key} check={view[key]} can={can} linksUrl={linksUrl} onRetry={retryFor(key)} />
          ))}
        </ul>
        <SendingDnsAdvisory />
      </div>
    </HomeSection>
  );
}
