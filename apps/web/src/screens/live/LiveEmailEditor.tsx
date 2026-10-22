import { useEffect, useRef, useState } from 'react';
import grapesjs, { type Editor } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import grapesjsMjml from 'grapesjs-mjml';
import { ArrowLeft, Code2, Eye, Paintbrush, Save, Send } from 'lucide-react';
import { Button, Pill, cx, inputBase, inputCls } from '../../components/ui';
import { api, errText, type Out } from '../liveApi';

// The e-mail editor on the real API (ADR-0006, spike 2): GrapesJS for visual editing, the MJML
// source as code, and previews rendered by the server exactly as they will be sent.

type Mode = 'visual' | 'code' | 'preview';
interface Template {
  purpose: string;
  subject: string;
  preheader?: string;
  mjml: string;
  text?: string;
  sampleData?: Record<string, unknown>;
}

// Spike 2: GrapesJS treats self-closing <mj-image /> as open tags, and escapes characters inside
// Liquid tags in text; normalise on the way in and out.
const expandSelfClosing = (m: string) => m.replace(/<(mj-[\w-]+)((?:\s[^>]*?)?)\s*\/>/g, '<$1$2></$1>');
const unescapeLiquid = (m: string) =>
  m.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, (t) => t.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
const liquidTokens = (s: string) => (s.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) ?? []).map((t) => t.replace(/\s+/g, ' ').trim()).sort();

export default function LiveEmailEditor({ id, onBack, onError }: { id: string; onBack: () => void; onError: (m: string) => void }) {
  const [artifact, setArtifact] = useState<Out<'artifacts.get'> | null>(null);
  const [t, setT] = useState<Template | null>(null);
  const [hash, setHash] = useState('');
  const [mode, setMode] = useState<Mode>('visual');
  const [preview, setPreview] = useState<Out<'templates.preview'> | null>(null);
  const [status, setStatus] = useState('');
  const [dirtyFromVisual, setDirtyFromVisual] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const baseline = useRef<string[]>([]);

  const load = async () => {
    try {
      const a = await api.call('artifacts.get', { artifactId: id });
      const content = a.version.content as Template;
      setArtifact(a);
      setT(content);
      setHash(a.version.contentHash);
      baseline.current = liquidTokens(content.mjml);
      editor.current?.setComponents(expandSelfClosing(content.mjml));
      setDirtyFromVisual(false);
    } catch (e) {
      onError(errText(e));
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [id]);

  const loaded = !!t;
  // The visual editor is created once, when the template has loaded; later edits flow through it.
  useEffect(() => {
    if (!host.current || !t || editor.current) return;
    const ed = grapesjs.init({
      container: host.current,
      height: '100%',
      width: 'auto',
      storageManager: false,
      fromElement: false,
      plugins: [grapesjsMjml],
      components: expandSelfClosing(t.mjml),
    });
    // The default panel buttons are Font Awesome icons, which the app does not load: label them.
    ed.on('load', () => {
      const labels: Record<string, string> = {
        'sw-visibility': 'Outlines', preview: 'Preview', fullscreen: 'Full screen', 'export-template': 'Code',
        'mjml-import': 'Import', 'open-sm': 'Styles', 'open-tm': 'Settings', 'open-layers': 'Layers', 'open-blocks': 'Blocks',
      };
      for (const panel of ed.Panels.getPanels().models)
        for (const b of panel.buttons.models) {
          const label = labels[b.id];
          if (label) b.set({ label: `<span style="font:500 11px var(--font-sans);padding:0 2px">${label}</span>`, className: '' });
        }
      ed.Panels.getButton('views', 'open-blocks')?.set('active', true);
    });
    ed.on('update', () => {
      setT((cur) => (cur ? { ...cur, mjml: unescapeLiquid(ed.getHtml()) } : cur));
      setDirtyFromVisual(true);
    });
    editor.current = ed;
    return () => {
      ed.destroy();
      editor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => {
    if (mode !== 'preview') return;
    api.call('templates.preview', { artifactId: id }).then(setPreview, (e) => onError(errText(e)));
  }, [mode, id, onError]);

  if (!t || !artifact) return <p className="text-muted">Loading…</p>;

  async function save() {
    if (!t) return;
    // Save-time guard: the visual editor must not silently change or drop Liquid.
    const now = liquidTokens(t.mjml);
    const lost = baseline.current.filter((x) => !now.includes(x));
    if (dirtyFromVisual && lost.length) {
      onError(`The visual editor would drop or change Liquid: ${lost.slice(0, 3).join(', ')}. Make this change in the code view.`);
      return;
    }
    try {
      const r = await api.call('artifacts.updateDraft', { artifactId: id, content: t, expectedContentHash: hash });
      setHash(r.contentHash);
      baseline.current = now;
      setDirtyFromVisual(false);
      setStatus(`Saved draft v${r.version}`);
      onError('');
      if (r.version !== artifact?.version.number) setArtifact(await api.call('artifacts.get', { artifactId: id }));
    } catch (e) {
      onError(errText(e));
    }
  }

  const tabs: { id: Mode; label: string; icon: typeof Eye }[] = [
    { id: 'visual', label: 'Visual', icon: Paintbrush },
    { id: 'code', label: 'MJML + Liquid', icon: Code2 },
    { id: 'preview', label: 'Preview', icon: Eye },
  ];

  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[600px] flex-col overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button variant="ghost" onClick={onBack} aria-label="Back to e-mails">
          <ArrowLeft size={16} />
        </Button>
        <div className="mr-2 min-w-0">
          <div className="truncate text-[15px] font-semibold">{artifact.name}</div>
          <div className="text-[11px] text-muted">
            v{artifact.version.number} {artifact.version.state.replace('_', ' ')} · purpose {t.purpose} {status && `· ${status}`}
          </div>
        </div>
        <div className="flex rounded-md border border-line p-0.5">
          {tabs.map((x) => (
            <button key={x.id} onClick={() => setMode(x.id)} className={cx('flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium', mode === x.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg')}>
              <x.icon size={13} /> {x.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <Button onClick={save}>
            <Save size={14} /> Save
          </Button>
          <Button
            variant="primary"
            disabled={artifact.version.state !== 'draft'}
            onClick={async () => {
              try {
                const r = await api.call('artifacts.requestPublish', { artifactId: id, note: 'Published from the e-mail editor' });
                setStatus(r.status === 'published' ? `Published v${r.version}` : 'Sent for approval');
                await load();
              } catch (e) {
                onError(errText(e));
              }
            }}
          >
            <Send size={14} /> Publish
          </Button>
        </div>
      </div>
      <div className="grid gap-2 border-b border-line bg-surface px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px]">
        <input className={inputCls} value={t.subject} onChange={(e) => setT({ ...t, subject: e.target.value })} aria-label="Subject" placeholder="Subject (Liquid)" />
        <input className={inputCls} value={t.preheader ?? ''} onChange={(e) => setT({ ...t, preheader: e.target.value || undefined })} aria-label="Preheader" placeholder="Preheader" />
        <input className={cx(inputBase, 'font-mono')} value={t.purpose} onChange={(e) => setT({ ...t, purpose: e.target.value })} aria-label="Purpose" />
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className={cx('absolute inset-0', mode !== 'visual' && 'hidden')} />
        {mode === 'code' && (
          <textarea
            className="absolute inset-0 h-full w-full resize-none bg-surface p-4 font-mono text-[12px] leading-relaxed text-fg outline-none"
            spellCheck={false}
            value={t.mjml}
            onChange={(e) => {
              setT({ ...t, mjml: e.target.value });
              editor.current?.setComponents(expandSelfClosing(e.target.value));
              setDirtyFromVisual(false);
            }}
            aria-label="MJML source"
          />
        )}
        {mode === 'preview' && (
          <div className="absolute inset-0 overflow-auto bg-surface-2 p-4">
            {preview ? (
              <div className="mx-auto max-w-[680px] space-y-2">
                <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
                  <b>{preview.subject}</b> <span className="text-muted">{preview.preheader}</span> <Pill>v{preview.version}</Pill>
                </div>
                {preview.warnings.length > 0 && <div className="rounded-md bg-warn-soft px-3 py-2 text-[12px] text-warn">{preview.warnings.join('; ')}</div>}
                <iframe title="Preview" sandbox="" className="h-[640px] w-full rounded-md border border-line bg-white" srcDoc={preview.html} />
                <p className="text-[11px] text-muted">Rendered by the server from the saved version with the template's sample data. Save to update.</p>
              </div>
            ) : (
              <p className="text-muted">Rendering…</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
