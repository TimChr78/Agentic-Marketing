import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Input } from './form';

/**
 * A text input for a list of values separated by commas. The raw text stays in local state while
 * someone types, so a trailing comma is not dropped before the next value; the parsed list is
 * reported on every change and an outside change (reload, discard) replaces the text.
 */
export function CommaListInput({
  value,
  onChange,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const joined = value.join(', ');
  const [text, setText] = useState(joined);
  const last = useRef(joined);

  useEffect(() => {
    if (joined !== last.current) {
      setText(joined);
      last.current = joined;
    }
  }, [joined]);

  const update = (raw: string) => {
    setText(raw);
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    last.current = items.join(', ');
    onChange(items);
  };

  return <Input {...props} value={text} onChange={(e) => update(e.target.value)} />;
}
