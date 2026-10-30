import { Checkbox, Field, Input, Select } from '../../ui';

// Named fields from an adapter's JSON Schema (#40): what the server validates is what the form asks
// for. Labels come from property names, help from the schema's descriptions.

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  format?: string;
  pattern?: string;
  anyOf?: JsonSchema[];
}

const ACRONYMS: Record<string, string> = { id: 'ID', url: 'URL', api: 'API', tls: 'TLS', smtp: 'SMTP', aws: 'AWS', ses: 'SES' };
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((w) => ACRONYMS[w] ?? w);
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const typeOf = (s: JsonSchema): string => {
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t) return t;
  const any = s.anyOf?.find((x) => x.type && x.type !== 'null');
  return any ? typeOf(any) : 'string';
};

/** Initial values: the schema's defaults. */
export function defaultsOf(schema: JsonSchema | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema?.properties ?? {}).flatMap(([k, s]) => (s.default !== undefined ? [[k, s.default]] : [])),
  );
}

/** Drops empty strings so optional fields stay unset. */
export function cleanValues(v: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== undefined));
}

export function SchemaForm({
  schema,
  value,
  onChange,
  errors = {},
  prefix,
  secret,
  keepHint,
  disabled,
}: {
  schema: JsonSchema | undefined;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  /** Field errors keyed `${prefix}.${key}`. */
  errors?: Record<string, string>;
  prefix: string;
  /** Credentials: password inputs, never prefilled. */
  secret?: boolean;
  /** Shown on credentials when some are already stored. */
  keepHint?: string;
  disabled?: boolean;
}) {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return <p className="text-[13px] text-muted">Nothing to set for this provider.</p>;
  const required = new Set(schema?.required ?? []);
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-4">
      {props.map(([key, s]) => {
        const t = typeOf(s);
        const label = humanize(key);
        const error = errors[`${prefix}.${key}`];
        const hint = [s.description, keepHint].filter(Boolean).join(' ');
        if (t === 'boolean')
          return (
            <div key={key}>
              <Checkbox
                label={label}
                hint={s.description}
                checked={value[key] === true}
                disabled={disabled}
                onChange={(e) => set(key, e.target.checked)}
              />
              {error && <p className="mt-1 text-[12px] text-bad">{error}</p>}
            </div>
          );
        if (s.enum)
          return (
            <Field key={key} label={label} hint={s.description} error={error} required={required.has(key)}>
              <Select value={String(value[key] ?? '')} disabled={disabled} onChange={(e) => set(key, e.target.value)}>
                {!required.has(key) && s.default === undefined && <option value="">Not set</option>}
                {s.enum.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </Select>
            </Field>
          );
        const numeric = t === 'integer' || t === 'number';
        return (
          <Field key={key} label={label} hint={hint || undefined} error={error} required={required.has(key) && !keepHint}>
            <Input
              type={secret ? 'password' : numeric ? 'number' : s.format === 'uri' ? 'url' : 'text'}
              autoComplete={secret ? 'new-password' : 'off'}
              spellCheck={false}
              disabled={disabled}
              min={s.minimum}
              max={s.maximum}
              value={value[key] === undefined || value[key] === null ? '' : String(value[key])}
              onChange={(e) => set(key, numeric ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
            />
          </Field>
        );
      })}
    </div>
  );
}
