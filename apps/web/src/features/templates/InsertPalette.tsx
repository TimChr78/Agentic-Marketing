import { ChevronRight, ImageIcon, Minus, MoveVertical, Square, Type, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Field, Input, Tabs } from '../../ui';
import { BlockList } from '../blocks/BlockPicker';

/** The six basic elements of the Insert palette (Phase 25, #499). No third-level library. */
export type InsertElementKind = 'text' | 'image' | 'button' | 'divider' | 'spacer' | 'columns';

const ELEMENTS: { kind: InsertElementKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'text', label: 'Text', icon: <Type size={16} aria-hidden /> },
  { kind: 'image', label: 'Image', icon: <ImageIcon size={16} aria-hidden /> },
  { kind: 'button', label: 'Button', icon: <ChevronRight size={16} aria-hidden /> },
  { kind: 'divider', label: 'Divider', icon: <Minus size={16} aria-hidden /> },
  { kind: 'spacer', label: 'Spacer', icon: <MoveVertical size={16} aria-hidden /> },
  { kind: 'columns', label: 'Columns', icon: <Square size={16} aria-hidden /> },
];

/**
 * The single Insert palette: basic MJML elements and reusable Liquid blocks in one anchored,
 * keyboard-operable dialog. Elements go into the visual editor; blocks go through the code path.
 */
export function InsertPalette({
  onClose,
  onInsertElement,
  onInsertImage,
  onInsertBlock,
}: {
  onClose: () => void;
  onInsertElement: (kind: InsertElementKind, columns?: 1 | 2) => void;
  onInsertImage: () => void;
  onInsertBlock: (tag: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'elements' | 'blocks'>('elements');
  const [query, setQuery] = useState('');
  const [columns, setColumns] = useState(false);
  const needle = query.trim().toLowerCase();
  const elements = ELEMENTS.filter((e) => !needle || e.label.toLowerCase().includes(needle));

  useEffect(() => {
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [onClose]);

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Insert"
      className="z-30 rounded-lg border border-line bg-surface shadow-2 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[70vh] max-md:overflow-y-auto max-md:rounded-b-none md:absolute md:top-full md:right-0 md:mt-2 md:w-80"
    >
      <div className="border-b border-line px-3 pt-3">
        <Tabs
          label="Insert category"
          value={tab}
          onChange={setTab}
          items={[
            { key: 'elements', label: 'Elements' },
            { key: 'blocks', label: 'Reusable blocks' },
          ]}
        >
          <div className="space-y-3 px-1 py-3">
            <Field label="Find an element or block">
              <Input ref={search} value={query} placeholder="Search insert palette" onChange={(e) => setQuery(e.target.value)} />
            </Field>
            {tab === 'elements' ? (
              <div>
                <div className="grid grid-cols-2 gap-2">
                  {elements.map((e) => (
                    <button
                      key={e.kind}
                      type="button"
                      onClick={() => {
                        if (e.kind === 'image') return onInsertImage();
                        if (e.kind === 'columns') return setColumns(true);
                        onInsertElement(e.kind);
                      }}
                      className="flex min-h-10 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-left text-[13px] font-medium text-fg hover:border-control hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:min-h-8"
                    >
                      <span className="text-fg-2">{e.icon}</span>
                      {e.label}
                    </button>
                  ))}
                </div>
                {columns && (
                  <fieldset className="mt-2 rounded-md border border-line bg-surface-2 p-2.5">
                    <legend className="mb-2 text-[12px] text-fg-2">Add a section with</legend>
                    <div className="flex gap-2">
                      {([1, 2] as const).map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => onInsertElement('columns', n)}
                          className="inline-flex min-h-10 flex-1 items-center justify-center rounded-md border border-line-strong bg-surface px-2 text-[13px] font-medium text-fg hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:min-h-8"
                        >
                          {n === 1 ? 'One' : 'Two'}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                )}
                {elements.length === 0 && <p className="mt-2 text-[13px] text-muted">No elements match “{query.trim()}”.</p>}
              </div>
            ) : (
              <div className="space-y-2">
                <BlockList query={query} onPick={onInsertBlock} />
                <p className="text-[12px] leading-[18px] text-muted">
                  <Wand2 size={12} className="mr-1 inline" aria-hidden />
                  Inserts a Liquid tag in MJML and Liquid. Fill parameter values; the published block expands on saved preview.
                </p>
              </div>
            )}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
