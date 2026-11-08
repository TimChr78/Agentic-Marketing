import { useState } from 'react';
import { api, errText } from '../../app/api';
import { Alert, Button, ListSkeleton, Modal, StatusPill } from '../../ui';
import { useAllArtifacts } from '../artifacts/artifactList';
import { type BlockContent, blockTagSnippet } from './model';

/**
 * Lists the workspace's blocks with their publication state. Shared by the standalone block
 * picker and the template editor's Insert palette (Phase 25, #499).
 */
export function BlockList({
  onPick,
  query = '',
  force = false,
}: {
  onPick: (tag: string) => void;
  query?: string;
  /** Render even while another pick is in flight (the palette manages its own closing). */
  force?: boolean;
}) {
  const list = useAllArtifacts('email_block');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();

  const choose = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const a = await api.call('artifacts.get', { artifactId: id });
      onPick(blockTagSnippet(id, ((a.version.content as BlockContent).params ?? []) as BlockContent['params']));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (list.loading)
    return (
      <div className="max-h-[320px] overflow-hidden rounded-md border border-line">
        <ListSkeleton label="Loading blocks" rows={4} columns={2} />
      </div>
    );
  if (list.error)
    return (
      <Alert tone="bad" onRetry={list.reload}>
        {list.error}
      </Alert>
    );
  const blocks = list.data?.artifacts ?? [];
  if (blocks.length === 0)
    return <p className="px-1 text-[13px] text-muted">No reusable blocks yet. Create one in Content → Templates, on the Blocks tab.</p>;
  const shown = blocks.filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.id.includes(needle));
  if (shown.length === 0)
    return (
      <p className="px-1 text-[13px] text-muted">
        No reusable blocks match “{query.trim()}”. Clear the search to see all {blocks.length}.
      </p>
    );

  return (
    <div className="space-y-2">
      {error && (
        <Alert tone="bad" className="mb-2">
          {error}
        </Alert>
      )}
      <ul className="max-h-[320px] divide-y divide-line overflow-y-auto rounded-md border border-line">
        {shown.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              disabled={!!busy && !force}
              onClick={() => void choose(a.id)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-fg">{a.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {a.publishedVersion ? (
                  <StatusPill tone="good">Published v{a.publishedVersion}</StatusPill>
                ) : (
                  <StatusPill>Not published</StatusPill>
                )}
                {busy === a.id && <span className="text-[12px] text-muted">Adding…</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Modal wrapper for inserting a reusable block from a template's toolbar. */
export function BlockPicker({ onClose, onPick }: { onClose: () => void; onPick: (tag: string) => void }) {
  return (
    <Modal open onClose={onClose} title="Insert a block" footer={<Button onClick={onClose}>Cancel</Button>}>
      <p className="mb-3 text-[13px] text-fg-2">
        The tag goes into the MJML and expands to the block’s published version when the e-mail is rendered. Fill the placeholders before
        publishing; a new block has to be published with the template.
      </p>
      <BlockList
        onPick={(tag) => {
          onPick(tag);
          onClose();
        }}
      />
    </Modal>
  );
}
