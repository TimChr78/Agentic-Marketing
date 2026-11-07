import { Alert, Meta, StatusPill } from '../../../ui';
import { holdoutVerdict, int, money, pointsText, rateText, signedPercentText } from './model';

// One holdout, campaign-wide or per journey (#511). The two are never merged: the title and the
// closing note say which cohort this is, and every returned currency keeps its own amount.

export type HoldoutArm = {
  entered: number;
  converted: number;
  unsubscribed: number;
  conversionRate: number;
  unsubscribeRate: number;
  revenue?: Record<string, number>;
};

export interface HoldoutPanelProps {
  title: string;
  kind: 'campaign' | 'journey';
  controlGroup: { percent: number; minSampleSize: number };
  control: HoldoutArm;
  treatment: HoldoutArm;
  absoluteLift: number;
  relativeLift: number | null;
  ci95: [number, number] | null;
  minSampleSizeMet: boolean;
  verdict: 'not_enough_data' | 'no_clear_difference' | 'treatment_better' | 'treatment_worse';
  note: string;
  goalEvent: string | null;
  attributionDays: number | null;
  assignmentPeriod: string;
}

function armRate(converted: number, entered: number, rate: number): string {
  if (!entered) return 'Unavailable';
  return `${int(converted)} / ${int(entered)} = ${rateText(rate, entered)}`;
}

function ArmCard({ label, arm }: { label: string; arm: HoldoutArm }) {
  return (
    <div className="rounded-md border border-line p-3">
      <p className="text-[13px] leading-5 font-semibold">{label}</p>
      <Meta
        className="mt-2"
        items={[
          ['Entered', int(arm.entered)],
          ['Converted', int(arm.converted)],
          ['Conversion rate', armRate(arm.converted, arm.entered, arm.conversionRate)],
          ['Unsubscribed', int(arm.unsubscribed)],
          ['Unsubscribe rate', armRate(arm.unsubscribed, arm.entered, arm.unsubscribeRate)],
        ]}
      />
    </div>
  );
}

export function HoldoutPanel(props: HoldoutPanelProps) {
  const verdict = holdoutVerdict(props);
  const insufficient = !props.minSampleSizeMet || props.verdict === 'not_enough_data';
  const includesZero = !!props.ci95 && props.ci95[0] <= 0 && props.ci95[1] >= 0;
  const inconclusive = !insufficient && (props.verdict === 'no_clear_difference' || includesZero);
  const noAssignments = props.control.entered + props.treatment.entered === 0;
  const currencies =
    props.kind === 'campaign'
      ? [...new Set([...Object.keys(props.control.revenue ?? {}), ...Object.keys(props.treatment.revenue ?? {})])]
      : [];
  const window = props.attributionDays === null ? 'campaign' : `${props.attributionDays}-day`;

  return (
    <section aria-label={props.title} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[16px] leading-6 font-semibold">{props.title}</h3>
          <p className="mt-1 text-[12px] leading-[18px] text-muted">
            {props.controlGroup.percent}% control · at least {int(props.controlGroup.minSampleSize)} per arm
            {props.goalEvent ? ` · ${props.goalEvent} within ${window} attribution window` : ''}
          </p>
        </div>
        <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
      </div>

      {insufficient && (
        <Alert tone="warn" className="mt-3" title="Insufficient sample">
          Control {int(props.control.entered)} / minimum {int(props.controlGroup.minSampleSize)}. No significance claim.
          {props.relativeLift === null ? ' Relative lift unavailable.' : ''}
        </Alert>
      )}
      {inconclusive && (
        <Alert tone="warn" className="mt-3" title="Inconclusive">
          The 95% interval {props.ci95 ? `${pointsText(props.ci95[0])} to ${pointsText(props.ci95[1])}` : 'is unavailable'}; no significance
          claim.
        </Alert>
      )}
      {noAssignments && (
        <Alert tone="info" className="mt-3" title="No assignments in this period">
          No people were assigned to this {props.kind === 'campaign' ? 'campaign' : 'journey'} holdout in this period.
        </Alert>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ArmCard label="Control" arm={props.control} />
        <ArmCard label="Treatment" arm={props.treatment} />
      </div>

      {props.kind === 'campaign' && (
        <div className="mt-4">
          <h4 className="text-[13px] leading-5 font-semibold">Revenue by currency</h4>
          {currencies.length === 0 ? (
            <p className="mt-1 text-[12px] leading-[18px] text-muted">Revenue unavailable.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {currencies.map((currency) => {
                const control = props.control.revenue?.[currency];
                const treatment = props.treatment.revenue?.[currency];
                return (
                  <li key={currency} className="rounded-md border border-line p-3">
                    <p className="text-[12px] leading-[18px] font-medium">{currency}</p>
                    <dl className="mt-1 grid grid-cols-[minmax(104px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px] leading-[18px]">
                      <dt className="text-muted">Control · {currency}</dt>
                      <dd className="text-right tabular-nums">{typeof control === 'number' ? money(control, currency) : '—'}</dd>
                      <dt className="text-muted">Treatment · {currency}</dt>
                      <dd className="text-right tabular-nums">{typeof treatment === 'number' ? money(treatment, currency) : '—'}</dd>
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-1 text-[12px] leading-[18px] text-muted">Revenue is not combined across currencies.</p>
        </div>
      )}

      <p className="mt-3 text-[12px] leading-[18px] text-fg-2">
        <strong>{pointsText(props.absoluteLift)}</strong> absolute lift ·{' '}
        {props.relativeLift === null ? 'Relative lift unavailable' : `${signedPercentText(props.relativeLift)} relative lift`} · 95%
        interval {props.ci95 ? `${pointsText(props.ci95[0])} to ${pointsText(props.ci95[1])}` : 'Unavailable'}
      </p>
      {props.control.converted === 0 && props.relativeLift === null && (
        <p className="mt-1 text-[12px] leading-[18px] text-muted">Zero control conversion makes relative lift unavailable.</p>
      )}
      <p className="mt-1 text-[12px] leading-[18px] text-muted">{props.note}</p>
      <p className="mt-1 text-[12px] leading-[18px] text-muted">
        Assignment period: {props.assignmentPeriod}. Conversion events follow the {window} goal attribution window.
      </p>
      <p className="mt-1 text-[12px] leading-[18px] text-muted">
        {props.kind === 'campaign'
          ? 'Campaign-wide; includes every sending member. Separate from journey controls; no broadcast-only lift.'
          : 'Journey control; separate from the campaign-wide holdout.'}
      </p>
    </section>
  );
}
