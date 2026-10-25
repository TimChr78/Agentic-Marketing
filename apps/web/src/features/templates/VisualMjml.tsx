import grapesjs, { type Editor } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import grapesjsMjml from 'grapesjs-mjml';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { expandSelfClosing, unescapeLiquid } from './liquid';

export interface VisualMjmlHandle {
  insertImage: (src: string, alt: string) => void;
}

/** GrapesJS with the MJML plugin (ADR-0006). Loaded lazily: it is large. */
const VisualMjml = forwardRef<VisualMjmlHandle, { mjml: string; onChange: (mjml: string) => void }>(function VisualMjml({ mjml, onChange }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const last = useRef(mjml);

  useImperativeHandle(ref, () => ({
    insertImage(src, alt) {
      const ed = editor.current;
      if (!ed) return;
      const sel = ed.getSelected();
      const target = sel?.is('mj-column') ? sel : (sel?.closest('mj-column') ?? ed.getWrapper()?.find('mj-column')[0]);
      target?.append(`<mj-image src="${src}" alt="${alt.replace(/"/g, '&quot;')}"></mj-image>`);
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    const ed = grapesjs.init({ container: host.current, height: '100%', width: 'auto', storageManager: false, fromElement: false, plugins: [grapesjsMjml], components: expandSelfClosing(mjml) });
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
      for (const panel of ed.Panels.getPanels().models)
        for (const b of panel.buttons.models) {
          const label = labels[b.id];
          if (label) b.set({ label: `<span style="font:500 11px var(--font-sans);padding:0 2px">${label}</span>`, className: '' });
        }
      ed.Panels.getButton('views', 'open-blocks')?.set('active', true);
    });
    ed.on('update', () => {
      const next = unescapeLiquid(ed.getHtml());
      last.current = next;
      changeRef.current(next);
    });
    editor.current = ed;
    return () => {
      ed.destroy();
      editor.current = null;
    };
    // Created once per mount; outside changes (discard, reload) remount via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="h-full" />;
});
export default VisualMjml;
