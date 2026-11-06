import { Monitor, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errText } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, CodeView, LoadingBlock, Meta, Segmented, Tabs } from '../../ui';
import { useArtifactRef } from '../artifactCache';
import { type DraftEmailContent, type DraftRender, draftUsesBlocks, renderDraft } from '../templates/localRender';
import { ChecksPanel } from './ChecksPanel';
import { PreviewLabel } from './PreviewLabel';
import { type PreviewSource, resolvePreviewSource } from './previewSource';

const DARK_MAIL_CSS = `html,body{background:#111512!important;color:#edf0e9!important}
body *:not(img):not(picture):not(svg):not(svg *){color:#edf0e9!important}
a{color:#8baafa!important}
img,picture,svg{filter:none!important;opacity:1!important}`;

/**
 * Wraps rendered e-mail HTML so links open outside the sandboxed preview. `darkMail` adds a
 * deterministic approximation stylesheet inside the preview document only; it never changes the
 * saved MJML and does not invert images.
 */
export function emailDoc(html: string, darkMail = false) {
  const doc = html.includes('<head>') ? html.replace('<head>', '<head><base target="_blank">') : `<base target="_blank">${html}`;
  if (!darkMail) return doc;
  const style = `<style data-am-dark-mail>${DARK_MAIL_CSS}</style>`;
  return doc.includes('</head>') ? doc.replace('</head>', `${style}</head>`) : `${style}${doc}`;
}

export type DraftEmailState =
  | { status: 'idle' }
  | { status: 'rendering' }
  | { status: 'blocked' }
  | { status: 'ready'; result: DraftRender }
  | { status: 'error'; message: string };

/**
 * Debounced local render of an unsaved draft (300 ms), sequenced so a slow completion cannot
 * replace newer input. A draft with `{% block %}` is reported as blocked, never faked or stripped.
 */
export function useDraftEmail(content: DraftEmailContent | undefined, enabled: boolean) {
  const [state, setState] = useState<DraftEmailState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const key = content ? JSON.stringify(content) : '';
  const seq = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the content object is keyed by its JSON form; an equal object must not restart the timer
  useEffect(() => {
    if (!enabled || !content) {
      setState({ status: 'idle' });
      return;
    }
    if (draftUsesBlocks(content)) {
      setState({ status: 'blocked' });
      return;
    }
    let live = true;
    const n = ++seq.current;
    setState({ status: 'rendering' });
    const timer = setTimeout(() => {
      renderDraft(content)
        .then((result) => {
          if (live && n === seq.current) setState({ status: 'ready', result });
        })
        .catch((e) => {
          if (live && n === seq.current) setState({ status: 'error', message: errText(e) });
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, enabled, attempt]);
  return { state, retry: () => setAttempt((a) => a + 1) };
}

/**
 * An e-mail as the recipient sees it (#41): rendered by the server with the template's sample
 * data, at desktop and mobile width, with subject, preheader and the plain-text part. With an
 * unsaved source and draft content it renders locally instead, so the label and the body always
 * describe the same thing (Phase 25, #499).
 */
export function EmailPreview({
  artifactId,
  version,
  compact,
  source,
  draftContent,
  sourceSuffix,
}: {
  artifactId: string;
  version?: number;
  compact?: boolean;
  source?: PreviewSource;
  draftContent?: DraftEmailContent;
  sourceSuffix?: string;
}) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const unsaved = source?.kind === 'unsaved';
  // An explicit version always wins; `source` is provenance, not a second way to choose a read.
  const pinned = version ?? (source && source.kind !== 'unsaved' ? source.version : undefined);
  const draft = unsaved ? draftContent : undefined;
  const local = useDraftEmail(draft, !!draft);
  // With no explicit version, resolve the returned version and the publication pointer before
  // choosing a label; never infer Published from a caller omission.
  const pointer = useArtifactRef(!source && version == null ? artifactId : null);
  const server = useApi(() => api.call('templates.preview', { artifactId, version: pinned }), [artifactId, pinned], {
    skip: !!unsaved,
  });
  const resolved =
    source ??
    resolvePreviewSource({
      requestedVersion: version,
      resolvedVersion: server.data?.version,
      publishedVersion: pointer.artifact?.publishedVersion,
    });
  const baseVersion = source?.kind === 'unsaved' ? source.baseVersion : undefined;
  const blocked = !!unsaved && !!draft && local.state.status === 'blocked';
  const savedFallback = useApi(() => api.call('templates.preview', { artifactId, version: baseVersion }), [artifactId, baseVersion], {
    skip: !blocked || !baseVersion,
  });

  if (unsaved && !draftContent)
    return (
      <div className="space-y-3">
        {source && <PreviewLabel source={source} suffix={sourceSuffix} />}
        <Alert tone="warn" title="Save draft to render this e-mail">
          A local render needs the draft content. Nothing saved is shown under an unsaved label.
        </Alert>
      </div>
    );

  if (blocked)
    return (
      <div className="space-y-3">
        {source && <PreviewLabel source={source} suffix={sourceSuffix} />}
        <Alert tone="warn" title="Save draft to render reusable blocks">
          This draft uses a reusable block, and only the server can expand it. The label above stays on your unsaved draft; the saved
          preview below is a separate source.
        </Alert>
        {savedFallback.data && (
          <details className="rounded-md border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer text-[12px] font-medium text-fg-2">Saved v{baseVersion} · previous saved preview</summary>
            <div className="mt-3 flex justify-center">
              <iframe
                title="Previous saved e-mail preview"
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                srcDoc={emailDoc(savedFallback.data.html)}
                className="rounded-sm bg-white shadow-1"
                style={{ width: '100%', maxWidth: 720, height: compact ? 420 : 640, border: 0 }}
              />
            </div>
          </details>
        )}
      </div>
    );

  const rendering = unsaved ? local.state.status === 'rendering' || local.state.status === 'idle' : server.loading;
  const failure = unsaved ? (local.state.status === 'error' ? local.state.message : null) : server.error;
  const shown: DraftRender | undefined = unsaved ? (local.state.status === 'ready' ? local.state.result : undefined) : server.data;
  const versionShown = unsaved ? undefined : server.data?.version;

  if (rendering) return <LoadingBlock lines={6} label={unsaved ? 'Rendering draft…' : 'Rendering the e-mail'} />;
  if (failure)
    return (
      <div className="space-y-3">
        {source && <PreviewLabel source={source} suffix={sourceSuffix} />}
        <Alert
          tone="bad"
          title={unsaved ? "Couldn't render this draft" : "Couldn't render this e-mail"}
          onRetry={unsaved ? local.retry : server.reload}
        >
          {failure}
        </Alert>
      </div>
    );
  if (!shown) return null;

  return (
    <div className="space-y-3">
      {resolved && <PreviewLabel source={resolved} suffix={sourceSuffix} />}
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
                  None. Inboxes show the first line of the body instead.
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
      {!unsaved && <ChecksPanel artifactId={artifactId} version={versionShown} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          label="Version"
          items={[
            { key: 'html', label: 'HTML' },
            { key: 'text', label: 'Text version' },
          ]}
          value={tab}
          onChange={setTab}
        />
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
      </div>
      {tab === 'html' ? (
        <div className="flex justify-center rounded-md border border-line bg-surface-3 p-3">
          <iframe
            title={`E-mail preview, ${width}`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={emailDoc(shown.html)}
            className="rounded-sm bg-white shadow-1"
            style={{
              width: width === 'mobile' ? 375 : '100%',
              maxWidth: width === 'mobile' ? 375 : 720,
              height: compact ? 520 : 720,
              border: 0,
            }}
          />
        </div>
      ) : unsaved && !draftContent?.text?.trim() ? (
        <Alert tone="info" title="Save draft to generate the text version">
          The local renderer does not invent a text version from HTML. Add a plain-text part to preview it here, or save and use the
          server’s text part.
        </Alert>
      ) : (
        <CodeView value={shown.text || '(empty)'} label="Plain-text part" maxHeight={compact ? 420 : 640} />
      )}
      <p className="text-[12px] text-muted">
        {unsaved
          ? 'Rendered locally from the unsaved draft with the template’s sample data.'
          : `Rendered from version ${versionShown} with the template's sample data.`}
      </p>
    </div>
  );
}
