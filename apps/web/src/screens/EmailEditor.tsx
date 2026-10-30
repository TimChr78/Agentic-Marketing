import grapesjs, { type Editor } from 'grapesjs';
import { useEffect, useRef, useState } from 'react';
import 'grapesjs/dist/css/grapes.min.css';
import grapesjsMjml from 'grapesjs-mjml';
import { Liquid } from 'liquidjs';
import { Code2, Eye, Mail, Paintbrush, Save } from 'lucide-react';
import mjml2html from 'mjml-browser';
import { exec } from '../api/commands';
import { AuthorBadge, Button, cx, inputBase, inputCls, Pill, timeAgo } from '../components/ui';
import { useStore } from '../mock/store';

const liquid = new Liquid({ strictVariables: false, strictFilters: false });
type Mode = 'visual' | 'code' | 'preview';

async function render(mjml: string, vars: Record<string, unknown>) {
  const filled = await liquid.parseAndRender(mjml, vars);
  const out = await Promise.resolve(mjml2html(filled, { validationLevel: 'soft' }));
  return out.html;
}

export default function EmailEditor() {
  const { templates, profiles, toast } = useStore();
  const [templateId, setTemplateId] = useState(templates[0].id);
  const template = templates.find((t) => t.id === templateId)!;
  const [mode, setMode] = useState<Mode>('visual');
  const [source, setSource] = useState(template.mjml);
  const [subject, setSubject] = useState(template.subject);
  const [profileId, setProfileId] = useState(profiles[0].id);
  const [variant, setVariant] = useState<'A' | 'B'>('A');
  const [preview, setPreview] = useState({ html: '', subject: '', error: '' });
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);

  // Reset working copy when switching template.
  useEffect(() => {
    setSource(template.mjml);
    setSubject(template.subject);
    editor.current?.setComponents(template.mjml);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  useEffect(() => {
    if (!host.current) return;
    const ed = grapesjs.init({
      container: host.current,
      height: '100%',
      width: 'auto',
      storageManager: false,
      fromElement: false,
      plugins: [grapesjsMjml],
      components: template.mjml,
    });
    ed.on('update', () => setSource(ed.getHtml()));
    // Default panel buttons use Font Awesome, which the demo does not load: label them in text.
    ed.on('load', () => {
      const labels: Record<string, string> = {
        'sw-visibility': 'Outlines',
        preview: 'Preview',
        fullscreen: 'Full screen',
        'export-template': 'Code',
        'mjml-import': 'Import',
        'open-sm': 'Styles',
        'open-tm': 'Settings',
        'open-layers': 'Layers',
        'open-blocks': 'Blocks',
      };
      ed.Panels.getPanels().forEach((panel: any) =>
        panel.buttons.forEach((b: any) => {
          const label = labels[b.id];
          if (label) b.set({ label: `<span style="font:500 11px var(--font-sans);padding:0 2px">${label}</span>`, className: '' });
        }),
      );
      ed.Panels.getButton('views', 'open-blocks')?.set('active', true);
    });
    editor.current = ed;
    return () => {
      ed.destroy();
      editor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const profile = profiles.find((p) => p.id === profileId)!;
  useEffect(() => {
    if (mode !== 'preview') return;
    const vars = {
      profile: { ...profile.traits, city: profile.city, email: profile.email },
      cart: { items: [{ name: 'Trailrunner GTX', image_url: '' }] },
      variant,
      unsubscribe_url: 'https://example.com/u/one-click',
    };
    Promise.all([render(source, vars), liquid.parseAndRender(subject, vars)])
      .then(([html, subj]) => setPreview({ html, subject: subj, error: '' }))
      .catch((e: Error) => setPreview({ html: '', subject: '', error: e.message }));
  }, [mode, source, subject, profile, variant]);

  async function save() {
    const res = await exec<{ version: number }>('templates.saveDraft', { templateId, subject, mjml: source });
    toast(`Saved ${template.name} draft v${res.version}`, 'good');
  }

  const tabs: { id: Mode; label: string; icon: typeof Eye }[] = [
    { id: 'visual', label: 'Visual', icon: Paintbrush },
    { id: 'code', label: 'MJML + Liquid', icon: Code2 },
    { id: 'preview', label: 'Preview', icon: Eye },
  ];

  return (
    <div className="flex h-full min-h-[640px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <Mail size={16} className="text-muted" />
        <select id="template" className={cx(inputBase, 'font-semibold')} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <Pill>v{template.version}</Pill>
        <AuthorBadge author={template.author} />
        <span className="text-[11px] text-muted">{timeAgo(template.updatedAt)}</span>
        <div className="flex rounded-md border border-line p-0.5">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setMode(t.id)}
              className={cx(
                'flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium',
                mode === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg',
              )}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
        <Button variant="primary" className="ml-auto" onClick={save}>
          <Save size={14} /> Save draft
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <label htmlFor="subject" className="text-[12px] font-medium text-muted">
          Subject
        </label>
        <input
          id="subject"
          className={cx(inputBase, 'min-w-0 flex-1 font-mono')}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <span className="hidden text-[11px] text-muted md:inline">
          Purpose: {template.purpose} · one-click unsubscribe added automatically
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* GrapesJS stays mounted so its state survives tab switches */}
        <div className={cx('absolute inset-0', mode !== 'visual' && 'invisible')}>
          <div ref={host} className="h-full" />
        </div>

        {mode === 'code' && (
          <div className="absolute inset-0 flex flex-col bg-surface">
            <textarea
              id="mjml-source"
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-surface p-4 font-mono text-[12px] leading-relaxed text-fg outline-none"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onBlur={() => editor.current?.setComponents(source)}
            />
            <div className="border-t border-line px-4 py-2 text-[11px] text-muted">
              This MJML is the canonical format. Agents write it via templates.create; the visual editor reads and writes the same document.
            </div>
          </div>
        )}

        {mode === 'preview' && (
          <div className="absolute inset-0 flex flex-col overflow-auto bg-surface-2 md:flex-row">
            <div className="shrink-0 space-y-3 border-b border-line bg-surface p-4 md:w-[260px] md:border-b-0 md:border-r">
              <div className="eyebrow">Render as</div>
              <select id="preview-profile" className={inputCls} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.slice(0, 14).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.city}
                  </option>
                ))}
              </select>
              <div className="flex gap-1">
                {(['A', 'B'] as const).map((v) => (
                  <Button key={v} variant={variant === v ? 'primary' : 'secondary'} onClick={() => setVariant(v)}>
                    Variant {v}
                  </Button>
                ))}
              </div>
              <div className="rounded-md border border-line p-2.5 text-[12px]">
                <div className="eyebrow mb-1">Liquid variables</div>
                <pre className="overflow-x-auto font-mono text-[11px] text-muted">
                  {JSON.stringify(
                    { first_name: profile.traits.first_name, city: profile.city, preferred_category: profile.traits.preferred_category },
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>
            <div className="min-w-0 flex-1 p-4">
              <div className="mx-auto max-w-[640px] overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
                <div className="border-b border-line px-4 py-2.5 text-[12px]">
                  <div className="text-muted">From: Fjeldvej Outdoor &lt;hej@fjeldvej.example&gt;</div>
                  <div className="font-semibold">{preview.subject || '…'}</div>
                </div>
                {preview.error ? (
                  <div className="p-4 font-mono text-[12px] text-bad">{preview.error}</div>
                ) : (
                  <iframe title="E-mail preview" className="h-[560px] w-full bg-white" srcDoc={preview.html} sandbox="" />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
