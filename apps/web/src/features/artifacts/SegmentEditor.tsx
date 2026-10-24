import { Field, Textarea } from '../../ui';
import { ConditionView } from '../previews/ConditionView';
import type { EditorProps } from './ArtifactDetailPage';
import { JsonEditor } from './JsonEditor';

// TODO(v0.2): replaced by the condition builder.
export function SegmentEditor({ content, onChange, readOnly, errors }: EditorProps<{ description?: string; condition?: unknown }>) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4">
        <Field label="Description" error={errors.description}>
          <Textarea rows={2} value={content.description ?? ''} readOnly={readOnly} onChange={(e) => onChange({ ...content, description: e.target.value })} />
        </Field>
        <JsonEditor label="Condition" value={content.condition} onChange={(c) => onChange({ ...content, condition: c })} readOnly={readOnly} rows={16} />
      </div>
      <div className="rounded-lg border border-line p-4">
        <ConditionView condition={content.condition} />
      </div>
    </div>
  );
}
