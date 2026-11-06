import { Eye, FileText, Monitor, Moon, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, CodeView, LoadingBlock, Meta, Segmented } from '../../ui';
import { emailDoc, useDraftEmail } from '../previews/EmailPreview';
import { PreviewLabel } from '../previews/PreviewLabel';
import type { PreviewSource } from '../previews/previewSource';
import type { DraftEmailContent, DraftRender } from './localRender';

/**
 * The editor's own preview (Phase 25, #499): the unsaved draft is rendered locally with the same
 * Liquid and MJML pipeline as the server, while a clean editor previews the exact saved version
 * through `templates.preview`. Width, dark mail and the text part are view modes, not versions.
 */
export function EditorPreview({
  artifactId,
  version,
  content,
  dirty,
  readOnly,
}: {
  artifactId: string;
  version: number;
  content: DraftEmailContent;
  dirty: boolean;
  readOnly?: boolean;
}) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));
  const [darkMail, setDarkMail] = useState(false);
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const draft = useDraftEmail(content, dirty && !readOnly);
  const saved = useApi(() => api.call('templates.preview', { artifactId, version }), [artifactId, version], { skip: dirty });
  const blocked = dirty && !readOnly && draft.state.status === 'blocked';
  const previous = useApi(() => api.call('templates.preview', { artifactId, version }), [artifactId, version], {
    skip: !blocked,
  });
  const source: PreviewSource = dirty ? { kind: 'unsaved', baseVersion: version } : { kind: 'saved', version };
  const shown: DraftRender | undefined =
    dirty && !readOnly ? (draft.state.status === 'ready' ? draft.state.result : undefined) : saved.data;
  const failure = dirty && !readOnly ? (draft.state.status === 'error' ? draft.state.message : null) : saved.error;
  const rendering = dirty && !readOnly ? draft.state.status === 'rendering' || draft.state.status === 'idle' : saved.loading;
  const frameWidth = width === 'mobile' ? 375 : 640;

  return (
    <div className="min-w-0 space-y-3">
      <PreviewLabel source={source} />
      <div className="flex flex-wrap items-center gap-2">
        {tab === 'html' && (
          <Segmented
            label="Preview width"
            value={width}
            onChange={setWidth}
            items={[
              { key: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },
              { key: 'mobile', label: 'Mobile', icon: <Smartphone size={13} aria-hidden /> },
            ]}
          />
        )}
        {tab === 'html' && (
          <button
            type="button"
            aria-pressed={darkMail}
            onClick={() => setDarkMail((v) => !v)}
            className={`inline-flex min-h-10 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium md:min-h-8 ${
              darkMail
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line-strong bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <Moon size={14} aria-hidden /> Dark mail
          </button>
        )}
        <Segmented
          label="Preview content"
          value={tab}
          onChange={setTab}
          items={[
            { key: 'html', label: 'HTML', icon: <Eye size={13} aria-hidden /> },
            { key: 'text', label: 'Text version', icon: <FileText size={13} aria-hidden /> },
          ]}
        />
      </div>
      {darkMail && tab === 'html' && <p className="text-[12px] leading-[18px] text-muted">Approximation — mail clients vary.</p>}

      {blocked ? (
        <div className="space-y-3">
          <Alert tone="warn" title="Save draft to render reusable blocks">
            The local preview cannot expand a reusable block. The Unsaved draft label stays on your local content; the saved preview below
            is a different source.
          </Alert>
          {previous.data && (
            <details className="rounded-md border border-line bg-surface px-3 py-2">
              <summary className="cursor-pointer text-[12px] font-medium text-fg-2">Saved v{version} · previous saved preview</summary>
              <div className="mt-3 flex justify-center rounded-md border border-line bg-surface-3 p-3">
                <iframe
                  title="Previous saved e-mail preview"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  srcDoc={emailDoc(previous.data.html)}
                  className="rounded-sm bg-white shadow-1"
                  style={{ width: '100%', maxWidth: 640, height: 520, border: 0 }}
                />
              </div>
            </details>
          )}
        </div>
      ) : rendering ? (
        <LoadingBlock lines={6} label={dirty ? 'Rendering draft…' : 'Rendering the e-mail'} />
      ) : failure ? (
        <Alert
          tone="bad"
          title={dirty ? "Couldn't render this draft" : "Couldn't render this e-mail"}
          onRetry={dirty ? draft.retry : saved.reload}
        >
          {failure}
        </Alert>
      ) : shown ? (
        <>
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
            <Meta
              items={[
                [
                  'Subject',
                  <span key="subject" className="font-medium">
                    {shown.subject}
                  </span>,
                ],
                [
                  'Preheader',
                  shown.preheader ? (
                    shown.preheader
                  ) : (
                    <span key="preheader" className="text-muted">
                      None
                    </span>
                  ),
                ],
              ]}
            />
          </div>
          {shown.warnings.length > 0 && (
            <Alert tone="warn" title="Rendering warnings">
              <ul className="list-disc pl-4">
                {shown.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}
          {tab === 'html' ? (
            <div className="flex justify-center rounded-md border border-line bg-surface-3 p-3">
              <iframe
                title={`E-mail preview, ${width}${darkMail ? ', dark mail' : ''}`}
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                srcDoc={emailDoc(shown.html, darkMail)}
                className={`rounded-sm shadow-1 ${darkMail ? '' : 'bg-white'}`}
                style={{ width: '100%', maxWidth: frameWidth, height: 620, border: 0, background: darkMail ? '#111512' : undefined }}
              />
            </div>
          ) : dirty && !content.text?.trim() ? (
            <Alert tone="info" title="Save draft to generate the text version">
              The local renderer does not invent a text part from HTML. Add one under Advanced, or save and preview the server’s text
              version.
            </Alert>
          ) : (
            <CodeView value={shown.text || '(empty)'} label="Plain-text part" maxHeight={620} />
          )}
          <p className="text-[12px] text-muted">
            {dirty
              ? 'Rendered locally from the unsaved draft with the template’s sample data.'
              : `Rendered from Saved v${version} with the template's sample data.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
