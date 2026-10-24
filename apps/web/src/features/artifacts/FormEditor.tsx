import type { EditorProps } from './ArtifactDetailPage';
import { JsonEditor } from './JsonEditor';

// TODO(v0.2): replaced by the form settings editor.
export function FormEditor({ content, onChange, readOnly }: EditorProps) {
  return <JsonEditor value={content} onChange={onChange} readOnly={readOnly} />;
}
