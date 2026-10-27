import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { api, errText } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { Alert, Button, JsonView, LoadingBlock, StatusPill, Table, TableFrame, Td, Th, THead, Tr } from '../../ui';
import type { Artifact } from './ArtifactDetailPage';

// Test runs of a prompt: the server queues one model call per test case and a worker runs them, so
// this queues the run and then polls until every case has an answer. A run keeps going on the
// worker when the tab closes, so opening the tab again resumes the latest one for this version.

interface TestCase {
  name: string;
  text?: string;
  traits?: Record<string, unknown>;
  events?: { name: string; properties?: Record<string, unknown> }[];
  expect?: { options?: string[]; contains?: string[]; notContains?: string[] };
}

interface CaseResult {
  index: number;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  passed: boolean;
  answer: unknown;
  problems: string[];
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

interface Run {
  status: 'running' | 'done';
  version: number | null;
  total: number;
  finished: number;
  pending: number;
  passed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  finishedAt: string | null;
  cases: CaseResult[];
  results: { name: string; passed: boolean; answer: unknown; problems: string[] }[];
}

interface RunSummary {
  runId: string;
  version: number | null;
  status: 'running' | 'done';
  total: number;
  finished: number;
  pending: number;
  passed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  startedAt: string;
  finishedAt: string | null;
}

const expectedText = (t: TestCase | undefined): string => {
  const e = t?.expect;
  if (!e) return '—';
  const parts: string[] = [];
  if (e.options?.length) parts.push(`one of ${e.options.join(', ')}`);
  if (e.contains?.length) parts.push(`contains ${e.contains.map((c) => `“${c}”`).join(', ')}`);
  if (e.notContains?.length) parts.push(`does not contain ${e.notContains.map((c) => `“${c}”`).join(', ')}`);
  return parts.length ? parts.join('; ') : '—';
};

const statusPill = (c: CaseResult) => {
  if (c.status === 'pending') return <StatusPill>Waiting</StatusPill>;
  if (c.status === 'running') return <StatusPill tone="info">Running</StatusPill>;
  return c.passed ? <StatusPill tone="good">Passed</StatusPill> : <StatusPill tone="bad">Failed</StatusPill>;
};

const usageText = (c: CaseResult): string => {
  const parts: string[] = [];
  if (c.latencyMs != null) parts.push(`${c.latencyMs} ms`);
  if (c.inputTokens || c.outputTokens) parts.push(`${c.inputTokens + c.outputTokens} tok (${c.inputTokens} in / ${c.outputTokens} out)`);
  return parts.length ? parts.join(' · ') : '—';
};

/** Runs a prompt's test cases on the configured AI provider and shows each case's answer. */
export function PromptTests({ artifact }: { artifact: Artifact }) {
  const { can } = useWorkspace();
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const content = artifact.version.content as { tests?: TestCase[] } | null;
  const cases = content?.tests ?? [];
  const version = artifact.version.number;

  // On opening (or coming back to) the tab, show the latest run for this version and resume
  // polling it if the worker is still answering its cases.
  useEffect(() => {
    let cancelled = false;
    setRunId(null);
    setRun(null);
    setSummaries([]);
    setError(null);
    setRunning(false);
    void api
      .call('prompts.testRuns', { artifactId: artifact.id, version, limit: 10 })
      .then((r) => {
        if (cancelled) return;
        const list = r.runs as RunSummary[];
        setSummaries(list);
        const latest = list[0];
        if (!latest) return;
        setRunId(latest.runId);
        if (latest.status === 'running') setRunning(true);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, version]);

  // Poll while the run is unfinished. Leaving the tab stops this loop; the run itself continues.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = (await api.call('prompts.testRun', { runId })) as Run;
        if (cancelled) return;
        setRun(r);
        setRunning(r.status === 'running');
        if (r.status === 'running') timer = setTimeout(tick, 1500);
      } catch (e) {
        if (cancelled) return;
        setError(errText(e));
        setRunning(false);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const runTests = async () => {
    setRunning(true);
    setError(null);
    setRun(null);
    setRunId(null);
    try {
      const { runId: next } = await api.call('prompts.test', { artifactId: artifact.id, version });
      setRunId(next);
      const r = await api.call('prompts.testRuns', { artifactId: artifact.id, version, limit: 10 });
      setSummaries(r.runs as RunSummary[]);
    } catch (e) {
      setError(errText(e));
      setRunning(false);
    }
  };

  const hasUsage = !!run && (run.inputTokens > 0 || run.outputTokens > 0 || run.latencyMs > 0);
  const latest = summaries[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-fg-2">
            Test runs call the AI provider configured for journeys, once per test case. They use tokens and every call is logged in the decision log.
          </p>
          <p className="mt-1 text-[12px] text-muted">
            {cases.length === 0 ? 'This prompt has no test cases yet. Add them under Content, in “Test cases (JSON)”.' : `${cases.length} test case${cases.length === 1 ? '' : 's'} in v${version}.`}{' '}
            A run uses the saved version; save unsaved edits first.
          </p>
        </div>
        {can('artifacts:write') && (
          <Button variant="primary" icon={<Play size={14} />} loading={running} disabled={!cases.length} onClick={() => void runTests()}>
            Run tests
          </Button>
        )}
      </div>
      {!can('artifacts:write') && <p className="text-[12px] text-muted">Running tests needs the artifacts:write permission.</p>}
      {error && (
        <Alert tone="bad" title="The tests could not run">
          {error}
        </Alert>
      )}
      {running && !run && <LoadingBlock lines={4} label="Running the test cases" />}
      {run && (
        <>
          <p className="text-[13px]" aria-live="polite">
            {run.status === 'done' ? 'Finished' : running ? 'Running' : 'Stopped'}: v{run.version ?? version}, {run.passed} passed, {run.failed} failed, {run.finished} of {run.total} done
            {run.status === 'running' ? (running ? '. Cases update every 1.5 seconds.' : '. Run it again to see the rest.') : '.'}
          </p>
          {hasUsage && (
            <p className="text-[12px] text-muted" aria-live="polite">
              This run used {run.inputTokens + run.outputTokens} tokens ({run.inputTokens} in / {run.outputTokens} out) and {run.latencyMs} ms across {run.finished} answered case
              {run.finished === 1 ? '' : 's'}.
            </p>
          )}
          <TableFrame
            isEmpty={!run.cases.length}
            empty={<p className="px-4 py-3 text-[13px] text-muted">No cases are queued yet. The model worker picks them up within a few seconds.</p>}
          >
            <Table label="Prompt test results">
              <THead>
                <tr>
                  <Th>Test case</Th>
                  <Th>Result</Th>
                  <Th>Answer</Th>
                  <Th className="hidden md:table-cell">Expected</Th>
                  {hasUsage && <Th className="hidden md:table-cell">Usage</Th>}
                </tr>
              </THead>
              <tbody>
                {run.cases.map((r) => {
                  const c = cases[r.index] ?? cases.find((x) => x.name === r.name);
                  return (
                    <Tr key={`${r.name}-${r.index}`}>
                      <Td>
                        <span className="font-medium text-fg">{r.name}</span>
                        {c?.text && <span className="mt-0.5 block text-[12px] text-muted">{c.text}</span>}
                        {r.problems.map((p) => (
                          <span key={p} className="mt-0.5 block text-[12px] text-bad">
                            {p}
                          </span>
                        ))}
                      </Td>
                      <Td>{statusPill(r)}</Td>
                      <Td>
                        {r.status === 'done' || r.status === 'failed' ? (
                          <JsonView value={r.answer} maxHeight={180} className="min-w-[180px]" />
                        ) : (
                          <span className="text-[12px] text-muted">{r.status === 'running' ? 'The model is answering…' : 'Waiting for a worker…'}</span>
                        )}
                      </Td>
                      <Td className="hidden md:table-cell">{expectedText(c)}</Td>
                      {hasUsage && <Td className="hidden md:table-cell whitespace-nowrap">{usageText(r)}</Td>}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
          {latest && (
            <p className="text-[12px] text-muted">
              Latest run {latest.runId.slice(0, 12)}… started {new Date(latest.startedAt).toLocaleString()}
              {latest.finishedAt ? ` and finished ${new Date(latest.finishedAt).toLocaleString()}` : ' and is still running'}. Opening this tab resumes polling its runId.
            </p>
          )}
        </>
      )}
      {!run && !running && !error && (
        <p className="text-[12px] text-muted">A decide or classify case passes when the answer is one of the expected options; a generate case when its text has the required phrases and the length and phrase checks pass.</p>
      )}
    </div>
  );
}
