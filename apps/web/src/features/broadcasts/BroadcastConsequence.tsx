import type { BroadcastConsequence as ConsequenceLines } from './detailView';

/**
 * The who/when/next inset above the tabs (#448). It is the operational consequence of the broadcast,
 * not a repeat of the metadata: who is reached, when it sends, and what to inspect next.
 */
export function BroadcastConsequence({ lines, templateName }: { lines: ConsequenceLines; templateName?: string | null }) {
  return (
    <div className="rounded-lg bg-surface-2 px-4 py-4 text-[13px] leading-5">
      <dl className="space-y-1.5">
        <div className="flex gap-2">
          <dt className="w-12 shrink-0 font-medium text-fg">Who</dt>
          <dd className="min-w-0 text-fg-2">
            {lines.who}
            {templateName && <span className="block text-[12px] leading-[18px] text-muted">Template {templateName}</span>}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-12 shrink-0 font-medium text-fg">When</dt>
          <dd className="min-w-0 text-fg-2">{lines.when}</dd>
        </div>
        {lines.draft && (
          <div className="flex gap-2">
            <dt className="w-12 shrink-0 font-medium text-fg">Draft</dt>
            <dd className="min-w-0 text-fg-2">{lines.draft}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="w-12 shrink-0 font-medium text-fg">Next</dt>
          <dd className="min-w-0 text-fg-2">{lines.next}</dd>
        </div>
      </dl>
    </div>
  );
}
