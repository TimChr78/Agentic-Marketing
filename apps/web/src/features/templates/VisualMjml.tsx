import grapesjs, { type Component, type Editor } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import grapesjsMjml from 'grapesjs-mjml';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { InsertElementKind } from './InsertPalette';
import './editor.css';
import { expandSelfClosing, imageTag, unescapeLiquid } from './liquid';

export interface VisualMjmlHandle {
  insertImage: (src: string, alt: string) => void;
  insertElement: (kind: InsertElementKind, columns?: 1 | 2) => void;
  undo: () => void;
  redo: () => void;
  toggleOutlines: () => void;
}

const ELEMENT_HTML: Record<Exclude<InsertElementKind, 'image' | 'columns'>, string> = {
  text: '<mj-text font-size="15px" line-height="24px">Write your text here.</mj-text>',
  button: '<mj-button href="https://example.com">Read more</mj-button>',
  divider: '<mj-divider border-color="#dddddd"></mj-divider>',
  spacer: '<mj-spacer height="24px"></mj-spacer>',
};

const sectionHtml = (columns: 1 | 2) => `<mj-section><mj-column></mj-column>${columns === 2 ? '<mj-column></mj-column>' : ''}</mj-section>`;

/** Depth-first components of a type; the wrapper itself is the mjml root, not the body. */
function findByType(root: Component | null | undefined, type: string): Component[] {
  if (!root) return [];
  const found: Component[] = [];
  const walk = (component: Component) => {
    if (component.get('type') === type) found.push(component);
    for (const child of component.components().models) walk(child as Component);
  };
  if (root.get('type') === type) found.push(root);
  for (const child of root.components().models) walk(child as Component);
  return found;
}

function closestByType(component: Component | null | undefined, type: string): Component | null {
  let current: Component | null = component ?? null;
  while (current) {
    if (current.get('type') === type) return current;
    current = (current.parent() as Component | null) ?? null;
  }
  return null;
}

/** The mj-body component. */
function bodyOf(ed: Editor): Component | null {
  return findByType(ed.getWrapper(), 'mj-body')[0] ?? null;
}

/** The selected column, else the first column in the body. */
function targetColumn(ed: Editor): Component | null {
  const selected = ed.getSelected();
  return closestByType(selected, 'mj-column') ?? findByType(bodyOf(ed), 'mj-column')[0] ?? null;
}

/** A column to insert into, creating a valid section/column wrapper inside the body when none exists. */
function ensureColumn(ed: Editor): Component | null {
  const existing = targetColumn(ed);
  if (existing) return existing;
  const body = bodyOf(ed);
  if (!body) return null;
  const added = body.append(sectionHtml(1));
  return findByType(added[0] ?? body, 'mj-column')[0] ?? null;
}

/**
 * GrapesJS with the MJML plugin (ADR-0006). Loaded lazily: it is large. The chrome is themed by
 * editor.css; only this editor's container uses it (#499).
 */
const VisualMjml = forwardRef<VisualMjmlHandle, { mjml: string; onChange: (mjml: string) => void; onReady?: () => void }>(
  function VisualMjml({ mjml, onChange, onReady }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<Editor | null>(null);
    const changeRef = useRef(onChange);
    changeRef.current = onChange;
    const readyRef = useRef(onReady);
    readyRef.current = onReady;

    const insertHtml = (html: string) => {
      const ed = editor.current;
      if (!ed) return;
      const column = ensureColumn(ed);
      if (!column) return;
      const added = column.append(html);
      ed.select(added[0] ?? column);
    };

    useImperativeHandle(ref, () => ({
      insertImage(src, alt) {
        insertHtml(expandSelfClosing(imageTag(src, alt)));
      },
      insertElement(kind, columns) {
        const ed = editor.current;
        if (!ed) return;
        if (kind === 'columns') {
          const selected = ed.getSelected();
          const section = closestByType(selected, 'mj-section');
          const html = sectionHtml(columns ?? 1);
          if (section?.parent()) {
            const parent = section.parent() as Component;
            const added = parent.append(html, { at: section.index() + 1 });
            ed.select(added[0] ?? section);
          } else {
            const body = bodyOf(ed);
            if (!body) return;
            const added = body.append(html);
            ed.select(added[0] ?? body);
          }
          return;
        }
        if (kind === 'image') return;
        insertHtml(ELEMENT_HTML[kind]);
      },
      undo() {
        editor.current?.runCommand('core:undo');
      },
      redo() {
        editor.current?.runCommand('core:redo');
      },
      toggleOutlines() {
        editor.current?.runCommand('core:component-outline');
      },
    }));

    // The editor is initialised once from the initial MJML; later changes are applied imperatively.
    // biome-ignore lint/correctness/useExhaustiveDependencies: remounting is controlled by the caller's key, not by the mjml prop
    useEffect(() => {
      if (!host.current) return;
      const ed = grapesjs.init({
        container: host.current,
        height: '100%',
        width: 'auto',
        storageManager: false,
        fromElement: false,
        plugins: [grapesjsMjml],
        // The plugin's own dark chrome (#2c2e35/#888686) is the contrast finding this task fixes;
        // the app tokens above style the chrome instead. Its device panel is also not wanted.
        pluginsOpts: { 'grapesjs-mjml': { useCustomTheme: false, resetDevices: false } },
        components: expandSelfClosing(mjml),
      });
      ed.on('update', () => {
        const next = unescapeLiquid(ed.getHtml());
        changeRef.current(next);
      });
      ed.onReady(() => {
        // One app toolbar: the GrapesJS command/device/block/fullscreen/preview chrome is removed.
        const panels = ed.Panels.getPanels();
        const optionsPanel = ed.Panels.getPanel('options');
        if (optionsPanel) panels.remove(optionsPanel);
        const devicesPanel = ed.Panels.getPanel('devices-c');
        if (devicesPanel) panels.remove(devicesPanel);
        // The emptied commands bar would otherwise sit over the top of the canvas (canvas top is 0).
        const commandsPanel = ed.Panels.getPanel('commands');
        if (commandsPanel) panels.remove(commandsPanel);
        const viewsPanel = ed.Panels.getPanel('views');
        const blocksButton = ed.Panels.getButton('views', 'open-blocks');
        if (viewsPanel && blocksButton) viewsPanel.buttons.remove(blocksButton);
        const labels: Record<string, string> = { 'open-sm': 'Styles', 'open-tm': 'Settings', 'open-layers': 'Layers' };
        for (const [id, label] of Object.entries(labels)) {
          ed.Panels.getButton('views', id)?.set({ label, className: 'am-gjs-tab' });
        }
        ed.Panels.getButton('views', 'open-sm')?.set('active', true);
        // Scroll containers must be reachable with the keyboard, labelled as regions, and keep
        // their arrow/PageDown scrolling (scrollable-region-focusable, #499).
        const scrollers: [string, string][] = [
          ['.gjs-pn-views-container', 'Editor inspector'],
          ['.gjs-sm-sectors', 'Style properties'],
          ['.gjs-trt-traits', 'Component settings'],
          ['.gjs-layers', 'Layers'],
          ['.gjs-clm-tags', 'Classes'],
          ['.gjs-cv-canvas', 'E-mail canvas'],
        ];
        for (const [selector, label] of scrollers) {
          for (const el of host.current?.querySelectorAll<HTMLElement>(selector) ?? []) {
            el.tabIndex = 0;
            el.setAttribute('role', 'region');
            el.setAttribute('aria-label', label);
          }
        }
        if (host.current) host.current.dataset.amGjsReady = 'true';
        readyRef.current?.();
      });
      editor.current = ed;
      return () => {
        ed.destroy();
        editor.current = null;
      };
      // Created once per mount; outside changes (discard, reload) remount via `key`.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return <div ref={host} className="am-gjs am-gjs-app h-full min-w-0" />;
  },
);
export default VisualMjml;
