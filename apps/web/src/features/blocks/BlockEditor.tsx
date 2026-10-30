import { Plus, Trash2 } from 'lucide-react';
import { Button, Checkbox, Field, Input, Select, Textarea } from '../../ui';
import type { EditorProps } from '../artifacts/ArtifactDetailPage';
import { type BlockCategory, type BlockContent, type BlockParam, type BlockParamType, CATEGORY_LABELS, PARAM_TYPES } from './model';

/**
 * The block editor: the MJML fragment as code, and the typed parameters templates fill in. The
 * preview tab renders the saved version with the defaults (blocks.preview).
 */
export function BlockEditor({ content, onChange, readOnly, errors }: EditorProps<BlockContent>) {
  const set = (p: Partial<BlockContent>) => onChange({ ...content, ...p });
  const setParam = (i: number, p: Partial<BlockParam>) =>
    set({ params: content.params.map((param, index) => (index === i ? { ...param, ...p } : param)) });
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <Field label="Description" hint="What the block is for, shown to reviewers and agents." error={errors.description}>
          <Input
            value={content.description ?? ''}
            readOnly={readOnly}
            maxLength={1000}
            onChange={(e) => set({ description: e.target.value || undefined })}
          />
        </Field>
        <Field label="Category" hint="Groups the block in the template editor." error={errors.category} required>
          <Select value={content.category} disabled={readOnly} onChange={(e) => set({ category: e.target.value as BlockCategory })}>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="MJML fragment"
        hint="Sections or columns, not a whole <mjml> document. Use {{ block.<key> }} for parameters; profile.* and unsubscribe_url also work."
        error={errors.mjml}
      >
        <Textarea
          mono
          rows={22}
          spellCheck={false}
          readOnly={readOnly}
          value={content.mjml}
          onChange={(e) => set({ mjml: e.target.value })}
        />
      </Field>

      <section aria-label="Parameters" className="rounded-lg border border-line bg-surface px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[13px] font-medium">Parameters</h2>
            <p className="text-[12px] text-muted">Templates pass these in the tag; html values are inserted raw, all others are escaped.</p>
          </div>
          {!readOnly && (
            <Button
              size="sm"
              icon={<Plus size={14} />}
              onClick={() =>
                set({
                  params: [...content.params, { key: '', label: '', type: 'text', required: false }],
                })
              }
            >
              Add parameter
            </Button>
          )}
        </div>
        {content.params.length === 0 ? (
          <p className="text-[13px] text-muted">No parameters: the block is the same wherever it is used.</p>
        ) : (
          <div className="space-y-3">
            {content.params.map((param, i) => (
              <div
                key={i}
                className="grid items-end gap-2 rounded-md border border-line bg-surface-2 p-3 sm:grid-cols-[120px_minmax(0,1fr)_130px_120px_minmax(0,1fr)_auto]"
              >
                <Field label="Key" hint="block.<key>" error={errors[`params.${i}.key`]}>
                  <Input
                    value={param.key}
                    readOnly={readOnly}
                    maxLength={31}
                    placeholder="title"
                    onChange={(e) => setParam(i, { key: e.target.value })}
                  />
                </Field>
                <Field label="Label" error={errors[`params.${i}.label`]}>
                  <Input value={param.label} readOnly={readOnly} maxLength={120} onChange={(e) => setParam(i, { label: e.target.value })} />
                </Field>
                <Field label="Type" error={errors[`params.${i}.type`]}>
                  <Select value={param.type} disabled={readOnly} onChange={(e) => setParam(i, { type: e.target.value as BlockParamType })}>
                    {PARAM_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Max length" error={errors[`params.${i}.maxLength`]}>
                  <Input
                    type="number"
                    min={1}
                    max={5000}
                    value={param.maxLength ?? ''}
                    readOnly={readOnly}
                    onChange={(e) => setParam(i, { maxLength: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </Field>
                <Field label="Default" hint="Used when the template omits it." error={errors[`params.${i}.default`]}>
                  <Input
                    value={param.default ?? ''}
                    readOnly={readOnly}
                    maxLength={5000}
                    onChange={(e) => setParam(i, { default: e.target.value || undefined })}
                  />
                </Field>
                <div className="flex items-center gap-2 pb-1.5">
                  <Checkbox
                    label="Required"
                    checked={!!param.required}
                    disabled={readOnly}
                    onChange={(e) => setParam(i, { required: e.target.checked })}
                  />
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={14} />}
                      aria-label={`Remove ${param.key || 'parameter'}`}
                      onClick={() => set({ params: content.params.filter((_, index) => index !== i) })}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
