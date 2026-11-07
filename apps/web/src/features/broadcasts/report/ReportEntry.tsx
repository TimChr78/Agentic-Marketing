import { useMemo, useState } from 'react';
import { useWorkspace } from '../../../app/session';
import { Alert, Button, Field, Select } from '../../../ui';
import { periodDateLabel, type ReportPeriodChoice, reportPeriod } from '../period';
import { ReportBody } from './ReportSections';

// The report's authorized shell. Kept behind a lazy boundary so importing the entry point for its
// pure helpers does not pull the session/theme singleton into a non-UI test context.
export default function ReportEntry({ artifactId }: { artifactId: string }) {
  const { can } = useWorkspace();
  const allowed = can('artifacts:read');
  const [choice, setChoice] = useState<ReportPeriodChoice>(7);
  const [anchor, setAnchor] = useState(() => new Date());
  const [refresh, setRefresh] = useState(0);
  const period = useMemo(() => reportPeriod(choice, anchor), [choice, anchor]);

  if (!allowed)
    return (
      <Alert tone="info" title="Report restricted">
        Your role needs artifacts:read. No analytics have been loaded.
      </Alert>
    );

  const reload = () => {
    setAnchor(new Date());
    setRefresh((value) => value + 1);
  };

  const choosePeriod = (value: number) => {
    setAnchor(new Date());
    setChoice(value === 30 ? 30 : 7);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] leading-6 font-semibold">Performance</h2>
          <p className="mt-1 text-[12px] leading-[18px] text-muted">
            {periodDateLabel(period)} · {period.zone} · people
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Period" className="w-[220px]">
            <Select value={choice} onChange={(event) => choosePeriod(Number(event.target.value))}>
              <option value={7}>Last 7 complete days</option>
              <option value={30}>Last 30 complete days</option>
            </Select>
          </Field>
          <Button variant="secondary" onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>
      <ReportBody key={`${period.from}:${refresh}`} artifactId={artifactId} period={period} />
    </div>
  );
}
