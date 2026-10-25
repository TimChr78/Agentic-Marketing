import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { api, errText } from '../../app/api';
import { useWorkspace } from '../../app/session';
import { Alert, Button, JsonView, LoadingBlock, StatusPill, Table, TableFrame, Td, Th, THead, Tr } from '../../ui';
import type { Artifact } from './ArtifactDetailPage';

// Test runs of a prompt: the server queues one model call per test case and a worker runs them, so
// this queues the run and then polls until every case has an answer.

interface TestCase {
  name: string;
  text?: string;
  traits?: Record<string, unknown>;
  events?: { name: string; properties?: Record<string, unknown> }[];
  expect?: { options?: string[]; contains?: string[]; notContains?: string[] };
}

interface ResultWithUsage {
  name: string;
  passed: boolean;
  answer: unknown;
  problems: string[];
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
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

/** Runs a prompt's test cases on the configured AI provider and shows each case's answer. */
export function PromptTests({ artifact }: { artifact: Artifact }) {
  const { can } = useWorkspace();
  const [run, setRun] = useState<{ version: number | null; passed: number; failed: number; results: ResultWithUsage[]; status: 'running' | 'done' } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const content = artifact.version.content as { tests?: TestCase[] } | null;
  const cases = content?.tests ?? [];
  const version = artifact.version.number;

  useEffect(() => {
    setRun(null);
    setError(null);
  }, [artifact.id, version]);

  const runTests = async () => {
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const { runId } = await api.call('prompts.test', { artifactId: artifact.id, version });
      let last: typeof run = null;
      for (let i = 0; i < 120; i++) {
        const r = await api.call('prompts.testRun', { runId });
        last = r as typeof run;
        setRun(last);
        if (r.status === 'done') break;
        if (i < 119) await new Promise((res) => setTimeout(res, 1500));
      }
      if (last && last.status !== 'done') setError('The run is still going after three minutes. The answers so far are shown; run the tests again to see the rest.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunning(false);
    }
  };

  const hasUsage = !!run?.results.some((r) => r.latencyMs != null || r.inputTokens != null || r.outputTokens != null);

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
            {run.status === 'done' ? 'Finished' : running ? 'Running' : 'Stopped'}: v{run.version ?? version}, {run.passed} passed, {run.failed} failed
            {run.status === 'running' && running ? ' so far. Results update every 1.5 seconds.' : '.'}
          </p>
          <TableFrame isEmpty={!run.results.length} empty={<p className="px-4 py-3 text-[13px] text-muted">No answers yet. The model worker picks the cases up within a few seconds.</p>}>
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
                {run.results.map((r, i) => {
                  const c = cases[i] ?? cases.find((x) => x.name === r.name);
                  return (
                    <Tr key={`${r.name}-${i}`}>
                      <Td>
                        <span className="font-medium text-fg">{r.name}</span>
                        {c?.text && <span className="mt-0.5 block text-[12px] text-muted">{c.text}</span>}
                        {r.problems.map((p) => (
                          <span key={p} className="mt-0.5 block text-[12px] text-bad">
                            {p}
                          </span>
                        ))}
                      </Td>
                      <Td>{r.passed ? <StatusPill tone="good">Passed</StatusPill> : <StatusPill tone="bad">Failed</StatusPill>}</Td>
                      <Td>
                        <JsonView value={r.answer} maxHeight={180} className="min-w-[180px]" />
                      </Td>
                      <Td className="hidden md:table-cell">{expectedText(c)}</Td>
                      {hasUsage && (
                        <Td className="hidden md:table-cell whitespace-nowrap">
                          {r.latencyMs != null ? `${r.latencyMs} ms` : '—'}
                          {r.inputTokens != null || r.outputTokens != null ? ` · ${(r.inputTokens ?? 0) + (r.outputTokens ?? 0)} tok` : ''}
                        </Td>
                      )}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        </>
      )}
      {!run && !running && !error && (
        <p className="text-[12px] text-muted">A decide or classify case passes when the answer is one of the expected options; a generate case when its text has the required phrases and the length and phrase checks pass.</p>
      )}
    </div>
  );
}
