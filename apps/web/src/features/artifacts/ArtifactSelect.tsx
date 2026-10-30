import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Select } from '../../ui';

/** Pick an artifact of one type; labels say which ones are live (only live ones can be used when publishing). */
export function ArtifactSelect({
  type,
  value,
  onChange,
  placeholder = 'Choose…',
  disabled,
  id,
  prefix,
}: {
  type: string;
  value: string | undefined;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  prefix?: string;
}) {
  const list = useApi(() => api.call('artifacts.list', { type: type as never, limit: 200 }), [type]);
  const items = (list.data?.artifacts ?? []).filter((a) => !prefix || a.id.startsWith(prefix));
  const known = !value || items.some((a) => a.id === value);
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled || list.loading}>
      <option value="">{list.loading ? 'Loading…' : list.error ? `Couldn't load: ${list.error}` : placeholder}</option>
      {!known && <option value={value}>{value} (not found)</option>}
      {items.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.publishedVersion ? ` · live v${a.publishedVersion}` : ' · not live yet'}
        </option>
      ))}
    </Select>
  );
}
