import { useState } from 'react';
import { api, errText } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, LoadingBlock, Modal, StatusPill } from '../../ui';
import { type BlockContent, blockTagSnippet } from './model';

/** Lists the workspace's blocks and inserts the Liquid tag with every parameter as a placeholder. */
export function BlockPicker({ onClose, onPick }: { onClose: () => void; onPick: (tag: string) => void }) {
  const list = useApi(() => api.call('artifacts.list', { type: 'email_block', limit: 200 }), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const a = await api.call('artifacts.get', { artifactId: id });
      onPick(blockTagSnippet(id, ((a.version.content as BlockContent).params ?? []) as BlockContent['params']));
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Insert a block"
      footer={
        <Button onClick={onClose} disabled={!!busy}>
          Cancel
        </Button>
      }
    >
      <p className="mb-3 text-[13px] text-fg-2">
        The tag goes into the MJML and expands to the block’s published version when the e-mail is rendered. Fill the placeholders before
        publishing; a new block has to be published with the template.
      </p>
      {error && (
        <Alert tone="bad" className="mb-3">
          {error}
        </Alert>
      )}
      {list.loading ? (
        <LoadingBlock lines={4} label="Loading blocks" />
      ) : list.error ? (
        <Alert tone="bad" onRetry={list.reload}>
          {list.error}
        </Alert>
      ) : (list.data?.artifacts.length ?? 0) === 0 ? (
        <p className="text-[13px] text-muted">No blocks yet. Create one under Design → Blocks first.</p>
      ) : (
        <ul className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-md border border-line">
          {list.data?.artifacts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void choose(a.id)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-fg">{a.name}</span>
                  <span className="block text-[12px] text-muted">{a.id}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {a.publishedVersion ? <StatusPill tone="good">Live v{a.publishedVersion}</StatusPill> : <StatusPill>Not live</StatusPill>}
                  {busy === a.id && <span className="text-[12px] text-muted">Adding…</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
