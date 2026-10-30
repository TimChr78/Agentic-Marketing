import { useEffect, useState } from 'react';
import { Field, Textarea } from '../../ui';

/** Content as JSON, for types without a form of their own. Parses on every change; shows the parse error. */
export function JsonEditor({
  value,
  onChange,
  readOnly,
  label = 'Content (JSON)',
  hint,
  rows = 22,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
  label?: string;
  hint?: string;
  rows?: number;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Follow outside changes (reload, discard) unless the text already means the same value.
    try {
      if (JSON.stringify(JSON.parse(text)) === JSON.stringify(value)) return;
    } catch {}
    setText(JSON.stringify(value, null, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Field label={label} hint={hint ?? 'The same JSON agents read and write. Call artifacts.types for the schema.'} error={error}>
      <Textarea
        mono
        rows={rows}
        spellCheck={false}
        readOnly={readOnly}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setError(null);
          } catch (err) {
            setError(`Not valid JSON yet: ${(err as Error).message}`);
          }
        }}
      />
    </Field>
  );
}
