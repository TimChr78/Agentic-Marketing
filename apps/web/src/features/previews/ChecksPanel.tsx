import { Link2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Card, Skeleton } from '../../ui';

type Checks = Out<'templates.check'>;
type Finding = Checks['findings'][number];

const severityOrder = ['blocking', 'warning'] as const;
const severityLabel: Record<string, string> = { blocking: 'Blocking', warning: 'Warnings', info: 'Notes' };
const severityTone: Record<string, string> = { blocking: 'text-bad', warning: 'text-warn', info: 'text-muted' };

function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="space-y-2">
      {findings.map((f) => (
        <li key={f.id} className="flex gap-2">
          <span className={`mt-[7px] size-1.5 shrink-0 rounded-full bg-current ${severityTone[f.severity]}`} aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] leading-[19px] text-fg">{f.message}</p>
            {(f.location || f.fix) && (
              <p className="mt-0.5 text-[12px] leading-[17px] break-words text-muted">
                {f.fix ?? null}
                {f.fix && f.location ? ' ' : null}
                {f.location ? <span className="font-mono text-[11px]">{f.location}</span> : null}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pre-send checks (#90) for an e-mail version: what a reader would hit that the template schema
 * cannot see. Instant findings load with the preview; link reachability is a separate button
 * because it fetches up to thirty URLs. Shown in the template preview and the approval drawer.
 */
export function ChecksPanel({ artifactId, version }: { artifactId: string; version?: number }) {
  const base = useApi(() => api.call('templates.check', { artifactId, version }), [artifactId, version]);
  const [full, setFull] = useState<Checks | null>(null);
  const [checkingLinks, setCheckingLinks] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // A new version invalidates the link-checked result too.
  const shown = full && base.data && full.version === base.data.version ? full : base.data;

  const checkLinks = async () => {
    setCheckingLinks(true);
    setLinkError(null);
    try {
      setFull(await api.call('templates.check', { artifactId, version, checkLinks: true }));
    } catch (e) {
      setLinkError(errText(e));
    } finally {
      setCheckingLinks(false);
    }
  };

  if (base.error && !shown)
    return (
      <Alert tone="bad" title="Couldn't check this e-mail" onRetry={base.reload}>
        {base.error}
      </Alert>
    );
  if (!shown)
    return (
      <Card title="Checks" padded>
        <Skeleton className="h-4 w-2/3" />
      </Card>
    );

  const { summary, findings } = shown;
  const problems = findings.length;
  const groups = severityOrder
    .map((s) => ({ severity: s, items: findings.filter((f) => f.severity === s) }))
    .filter((g) => g.items.length > 0);
  const notes = findings.filter((f) => f.severity === 'info');

  return (
    <Card
      title="Checks"
      description={
        problems === 0
          ? 'No problems found in the rendered e-mail.'
          : `${summary.blocking} blocking · ${summary.warning} warnings · ${summary.info} notes`
      }
      action={
        findings.length > 0 || !full ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Link2 size={14} aria-hidden />}
            loading={checkingLinks}
            onClick={checkLinks}
            title="Fetch the links in this e-mail (up to 30, cached for an hour)"
          >
            Check links
          </Button>
        ) : null
      }
      padded
    >
      <div className="space-y-3">
        {linkError && (
          <Alert tone="warn" title="Link checking failed">
            {linkError}
          </Alert>
        )}
        {problems === 0 && <p className="text-[13px] text-fg-2">Nothing to fix before sending.</p>}
        {groups.map((g) => (
          <section key={g.severity} aria-label={severityLabel[g.severity]}>
            <h3 className={`text-[12px] font-semibold tracking-wide uppercase ${severityTone[g.severity]}`}>
              {severityLabel[g.severity]} ({g.items.length})
            </h3>
            <div className="mt-1.5">
              <FindingList findings={g.items} />
            </div>
          </section>
        ))}
        {notes.length > 0 && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-[12px] font-semibold tracking-wide text-muted uppercase hover:text-fg-2">
              {severityLabel.info} ({notes.length})
            </summary>
            <div className="mt-1.5">
              <FindingList findings={notes} />
            </div>
          </details>
        )}
        {!full && problems > 0 && (
          <p className="flex items-center gap-1 text-[12px] text-muted">
            <RefreshCw size={12} aria-hidden /> Link reachability is not checked yet.
          </p>
        )}
      </div>
    </Card>
  );
}
