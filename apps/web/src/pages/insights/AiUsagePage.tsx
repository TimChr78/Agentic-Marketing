import { Bot } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { api, type Out } from '../../app/api';
import { ButtonLink, TextLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { StatCard, StatGrid } from '../../features/insights/Stats';
import {
  Alert,
  EmptyState,
  Field,
  formatDateTime,
  JsonView,
  LoadingBlock,
  Mono,
  PageHeader,
  Select,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

type Call = Out<'ai.calls'>['calls'][number];
type Kind = Call['kind'];

const kinds: Kind[] = ['decide', 'generate', 'copilot', 'test', 'classify'];
const callTone = { pending: 'neutral', running: 'neutral', done: 'good', fallback: 'warn', failed: 'bad' } as const;

function outcome(c: Call): string {
  if (c.error) return c.error;
  if (c.rationale) return c.rationale;
  if (c.cached) return 'Served from the cache; no model call.';
  if (typeof c.output === 'string') return c.output;
  if (c.output === null || c.output === undefined) return 'No answer recorded.';
  return JSON.stringify(c.output);
}

/** AI usage per period and kind, and the decision log of every call. */
export default function AiUsagePage() {
  useCrumbs([{ label: 'AI usage' }]);
  const { can } = useSession();
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState<'' | Kind>('');
  const [open, setOpen] = useState<string | null>(null);

  const usage = useApi(() => api.call('ai.usage', { days }), [days]);
  const calls = useApi(() => api.call('ai.calls', { ...(kind ? { kind } : {}), limit: 200 }), [kind]);
  const reviews = useApi(() => api.call('ai.reviews', { status: 'pending', limit: 50 }), []);

  const totals = useMemo(() => {
    const rows = usage.data?.days ?? [];
    return rows.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        fallbacks: acc.fallbacks + r.fallbacks,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
      }),
      { calls: 0, fallbacks: 0, inputTokens: 0, outputTokens: 0 },
    );
  }, [usage.data]);

  const byKind = useMemo(() => {
    const map = new Map<
      string,
      {
        calls: number;
        fallbacks: number;
        inputTokens: number;
        outputTokens: number;
        cost: number | null;
        unpriced: boolean;
        models: Set<string>;
      }
    >();
    for (const r of usage.data?.days ?? []) {
      const row = map.get(r.kind) ?? {
        calls: 0,
        fallbacks: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
        unpriced: false,
        models: new Set<string>(),
      };
      row.calls += r.calls;
      row.fallbacks += r.fallbacks;
      row.inputTokens += r.inputTokens;
      row.outputTokens += r.outputTokens;
      if (r.model) row.models.add(r.model);
      // Unknown models have no price, so the kind's total is a floor, marked with "+".
      if (r.cost === null) row.unpriced = true;
      else row.cost = (row.cost ?? 0) + r.cost;
      map.set(r.kind, row);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].calls - a[1].calls);
  }, [usage.data]);

  const usd = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`);

  const callRows = calls.data?.calls ?? [];
  const reviewRows = reviews.data?.reviews ?? [];
  const quality = reviews.data?.quality ?? [];

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="AI usage"
        description="Tokens spent, fallbacks taken and every decision the AI runtime made. Prompts and provider settings live elsewhere."
        actions={can('workspace:admin') && <TextLink to="/settings/providers">Manage AI providers</TextLink>}
      />

      <div className="mb-4 max-w-[160px]">
        <Field label="Period">
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        </Field>
      </div>

      {usage.loading ? (
        <LoadingBlock lines={4} label="Loading AI usage" />
      ) : usage.error ? (
        <Alert tone="bad" title="Couldn't load AI usage" onRetry={usage.reload} className="mb-5">
          {usage.error}
        </Alert>
      ) : (
        <>
          <StatGrid columns={4} className="mb-5">
            <StatCard label="AI calls" value={totals.calls.toLocaleString()} />
            <StatCard label="Input tokens" value={totals.inputTokens.toLocaleString()} />
            <StatCard label="Output tokens" value={totals.outputTokens.toLocaleString()} />
            <StatCard
              label="Fallbacks and failures"
              value={totals.fallbacks.toLocaleString()}
              tone={totals.fallbacks > 0 ? 'warn' : undefined}
            />
          </StatGrid>
          <p className="-mt-3 mb-5 text-[12px] text-muted">
            Last {days} days. Token counts are per call as reported by the provider. Cost is an estimate from a price table in code (USD per
            million tokens); models without a price are left out.
          </p>

          <div className="mb-5 overflow-hidden rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-[14px] font-semibold">Usage by kind</h2>
            </div>
            {byKind.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-muted">No AI calls in this period.</p>
            ) : (
              <Table label="AI usage by kind">
                <THead>
                  <tr>
                    <Th>Kind</Th>
                    <Th>Models</Th>
                    <Th align="right">Calls</Th>
                    <Th align="right">Fallbacks</Th>
                    <Th align="right">Input tokens</Th>
                    <Th align="right">Output tokens</Th>
                    <Th align="right">Est. cost</Th>
                  </tr>
                </THead>
                <tbody>
                  {byKind.map(([k, r]) => (
                    <Tr key={k}>
                      <Td>
                        <Tag>{k}</Tag>
                      </Td>
                      <Td className="max-w-[260px]">
                        <span className="line-clamp-2">
                          {r.models.size ? [...r.models].join(', ') : <span className="text-muted">Unknown</span>}
                        </span>
                      </Td>
                      <Td align="right">{r.calls.toLocaleString()}</Td>
                      <Td align="right">{r.fallbacks.toLocaleString()}</Td>
                      <Td align="right">{r.inputTokens.toLocaleString()}</Td>
                      <Td align="right">{r.outputTokens.toLocaleString()}</Td>
                      <Td align="right" className="whitespace-nowrap">
                        {r.cost === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <>
                            {usd(r.cost)}
                            {r.unpriced && <span className="text-muted">+</span>}
                          </>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </>
      )}

      <section aria-labelledby="log-heading" className="mb-5">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="log-heading" className="text-[14px] font-semibold">
              Decision log
            </h2>
            <p className="mt-0.5 text-[12px] text-muted">
              The latest 200 calls with their rationale, fallback reason and what the model saw.
            </p>
          </div>
          <Select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value as '' | Kind)} className="w-auto">
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </div>
        <TableFrame
          loading={calls.loading}
          error={calls.error}
          onRetry={calls.reload}
          columns={6}
          isEmpty={callRows.length === 0}
          empty={
            <EmptyState
              icon={<Bot size={16} />}
              title={kind ? `No “${kind}” calls yet` : 'No AI calls yet'}
              action={can('artifacts:read') && <ButtonLink to="/build/prompts">Go to AI prompts</ButtonLink>}
            >
              Decisions from journey AI steps, prompt tests and copilot turns appear here.
            </EmptyState>
          }
        >
          <Table label="AI decision log">
            <THead>
              <tr>
                <Th>Outcome</Th>
                <Th className="hidden md:table-cell">Kind</Th>
                <Th>Prompt</Th>
                <Th className="hidden lg:table-cell">What happened</Th>
                <Th align="right">Latency</Th>
                <Th>When</Th>
              </tr>
            </THead>
            <tbody>
              {callRows.map((c) => (
                <Fragment key={c.id}>
                  <Tr onClick={() => setOpen(open === c.id ? null : c.id)} selected={open === c.id}>
                    <Td>
                      <StatusPill tone={callTone[c.status] ?? 'neutral'}>{c.status}</StatusPill>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <Tag>{c.kind}</Tag>
                    </Td>
                    <Td>
                      {c.promptId ? (
                        <>
                          <Mono className="bg-transparent px-0">{c.promptId.slice(0, 14)}…</Mono>
                          <span className="ml-1 text-[12px] text-muted">v{c.promptVersion ?? '?'}</span>
                        </>
                      ) : (
                        <span className="text-muted">No prompt</span>
                      )}
                      <div className="text-[12px] text-muted">{c.model ?? 'No model'}</div>
                    </Td>
                    <Td className="hidden max-w-[420px] lg:table-cell">
                      <span className="line-clamp-2">{outcome(c)}</span>
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {c.latencyMs === null ? '—' : `${c.latencyMs.toLocaleString()} ms`}
                      <div className="text-[12px] text-muted">{(c.inputTokens + c.outputTokens).toLocaleString()} tok</div>
                    </Td>
                    <Td className="whitespace-nowrap" title={formatDateTime(c.createdAt)}>
                      {timeAgo(c.createdAt)}
                    </Td>
                  </Tr>
                  {open === c.id && (
                    <tr key={`${c.id}-detail`} className="border-t border-line bg-surface-2">
                      <Td colSpan={6} className="p-3">
                        <JsonView
                          label="Call detail"
                          value={{
                            status: c.status,
                            kind: c.kind,
                            model: c.model,
                            prompt: c.promptId ? `${c.promptId}@${c.promptVersion ?? '?'}` : null,
                            journey: c.journeyId,
                            node: c.node,
                            profile: c.profileId,
                            rationale: c.rationale,
                            error: c.error,
                            cached: c.cached,
                            input: c.input,
                            output: c.output,
                          }}
                          maxHeight={320}
                        />
                      </Td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </section>

      {reviews.data && (reviewRows.length > 0 || quality.length > 0) && (
        <section aria-labelledby="reviews-heading">
          <h2 id="reviews-heading" className="mb-1 text-[14px] font-semibold">
            Answers to review
          </h2>
          <p className="mb-2 text-[12px] text-muted">Sampled AI answers waiting for a person to judge, and the quality per prompt.</p>
          {quality.length > 0 && (
            <div className="mb-3 overflow-hidden rounded-lg border border-line bg-surface">
              <Table label="Review quality">
                <THead>
                  <tr>
                    <Th>Prompt</Th>
                    <Th align="right">Waiting</Th>
                    <Th align="right">Good</Th>
                    <Th align="right">Bad</Th>
                    <Th align="right">Good rate</Th>
                  </tr>
                </THead>
                <tbody>
                  {quality.map((q) => (
                    <Tr key={q.promptId}>
                      <Td>
                        <Mono className="break-all bg-transparent px-0">{q.promptId}</Mono>
                      </Td>
                      <Td align="right">{q.pending.toLocaleString()}</Td>
                      <Td align="right">{q.good.toLocaleString()}</Td>
                      <Td align="right">{q.bad.toLocaleString()}</Td>
                      <Td align="right">{q.goodRate === null ? '—' : `${Math.round(q.goodRate * 100)}%`}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          {reviewRows.length > 0 && (
            <TableFrame columns={3} isEmpty={false}>
              <Table label="Answers waiting for review">
                <THead>
                  <tr>
                    <Th>Kind</Th>
                    <Th>Prompt</Th>
                    <Th>When</Th>
                    <Th>Answer</Th>
                  </tr>
                </THead>
                <tbody>
                  {reviewRows.map((r) => (
                    <Tr key={r.callId}>
                      <Td>
                        <Tag>{r.kind}</Tag>
                      </Td>
                      <Td>{r.promptId ? `${r.promptId.slice(0, 14)}… v${r.promptVersion ?? '?'}` : '—'}</Td>
                      <Td className="whitespace-nowrap" title={formatDateTime(r.createdAt)}>
                        {timeAgo(r.createdAt)}
                      </Td>
                      <Td className="max-w-[420px]">
                        <span className="line-clamp-2">
                          {r.rationale ?? (typeof r.output === 'string' ? r.output : JSON.stringify(r.output))}
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          )}
        </section>
      )}
    </div>
  );
}
