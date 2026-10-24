import { useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Actor, Alert, DiffView, formatDateTime, JsonView, LoadingBlock, StatePill, Table, TableFrame, Tabs, Td, Th, THead, timeAgo, Tr } from '../../ui';
import type { Artifact } from './ArtifactDetailPage';

/** Every version with state, author and note; pick one to see what changed in it. */
export function VersionsPanel({ artifact }: { artifact: Artifact }) {
  const h = useApi(() => api.call('artifacts.history', { artifactId: artifact.id }), [artifact.id, artifact.latestVersion, artifact.version.contentHash]);
  const [open, setOpen] = useState<number | null>(null);
  const versions = h.data?.versions ?? [];
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <TableFrame loading={h.loading} error={h.error} onRetry={h.reload} isEmpty={!versions.length} columns={4}>
        <Table label="Versions">
          <THead>
            <tr>
              <Th>Version</Th>
              <Th>State</Th>
              <Th>By</Th>
              <Th>When</Th>
            </tr>
          </THead>
          <tbody>
            {versions.map((v) => (
              <Tr key={v.number} onClick={() => setOpen(v.number)} selected={open === v.number}>
                <Td>
                  <span className="font-medium text-fg">v{v.number}</span>
                  {v.note && <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{v.note}</p>}
                </Td>
                <Td>
                  <StatePill state={v.state} />
                </Td>
                <Td>
                  {v.by ? <Actor kind={v.by.kind === 'person' ? 'person' : v.by.kind === 'token' ? 'token' : 'agent'} name={v.by.tokenName ?? v.by.clientName ?? v.by.displayName} detail={v.by.kind !== 'person' ? (v.by.personName ?? undefined) : undefined} /> : v.author.type}
                </Td>
                <Td className="whitespace-nowrap" title={formatDateTime(v.createdAt, { zone: true })}>
                  {timeAgo(v.createdAt)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      <div>{open ? <VersionDetail artifactId={artifact.id} number={open} /> : <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">Select a version to see what changed in it.</p>}</div>
    </div>
  );
}

function VersionDetail({ artifactId, number }: { artifactId: string; number: number }) {
  const [view, setView] = useState<'diff' | 'content'>('diff');
  const diff = useApi(() => api.call('artifacts.diff', { artifactId, from: number > 1 ? number - 1 : undefined, to: number }), [artifactId, number]);
  const content = useApi(() => api.call('artifacts.get', { artifactId, version: number }), [artifactId, number], { skip: view !== 'content' });
  return (
    <Tabs
      label={`Version ${number}`}
      value={view}
      onChange={setView}
      items={[
        { key: 'diff', label: number > 1 ? `Changes from v${number - 1}` : 'First version' },
        { key: 'content', label: 'Content' },
      ]}
    >
      {view === 'diff' &&
        (diff.loading ? <LoadingBlock /> : diff.error ? <Alert tone="bad">{diff.error}</Alert> : diff.data && <DiffView changes={diff.data.changes} from={number > 1 ? number - 1 : null} to={number} />)}
      {view === 'content' && (content.loading ? <LoadingBlock /> : content.error ? <Alert tone="bad">{content.error}</Alert> : <JsonView value={content.data?.version.content} maxHeight={560} />)}
    </Tabs>
  );
}
