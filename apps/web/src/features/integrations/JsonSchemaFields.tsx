import { useState } from 'react';
import { Field, Textarea } from '../../ui';
import { humanize, type JsonSchema, SchemaForm } from '../providers/SchemaForm';

// Connector settings and secrets arrive from connectors.list as JSON Schemas (z.toJSONSchema).
// SchemaForm handles flat fields; records and arrays (headers, scopes, mappings) are easier to edit
// as JSON, and the server validates them the same way.

const typeOf = (s: JsonSchema): string | undefined => {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null');
  if (s.type) return s.type;
  return s.anyOf?.map(typeOf).find((t) => t && t !== 'null');
};
const complex = (s: JsonSchema) => {
  const t = typeOf(s);
  return t === 'object' || t === 'array';
};

function textOf(value: unknown, schema: JsonSchema): string {
  const v = value === undefined ? (schema.default ?? (typeOf(schema) === 'array' ? [] : {})) : value;
  return JSON.stringify(v, null, 2);
}

function JsonField({
  name,
  schema,
  value,
  onChange,
  error,
  required,
  disabled,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  required: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => textOf(value, schema));
  const [parseError, setParseError] = useState<string | null>(null);
  const change = (raw: string) => {
    setText(raw);
    if (!raw.trim()) {
      setParseError(null);
      onChange(undefined);
      return;
    }
    try {
      onChange(JSON.parse(raw));
      setParseError(null);
    } catch {
      setParseError(typeOf(schema) === 'array' ? 'Enter valid JSON, e.g. ["value"].' : 'Enter valid JSON, e.g. {"key": "value"}.');
    }
  };
  return (
    <Field label={humanize(name)} hint={schema.description} error={parseError ?? error} required={required}>
      <Textarea
        mono
        rows={typeOf(schema) === 'array' ? 2 : 3}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => change(e.target.value)}
      />
    </Field>
  );
}

/** Named fields from a connector's JSON Schema, with records and arrays edited as JSON. */
export function JsonSchemaFields({
  schema,
  value,
  onChange,
  errors = {},
  prefix,
  keepHint,
  disabled,
}: {
  schema: JsonSchema | undefined;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  /** Field errors keyed `${prefix}.${key}`. */
  errors?: Record<string, string>;
  prefix: string;
  /** Shown on credentials when some are already stored. */
  keepHint?: string;
  disabled?: boolean;
}) {
  const entries = Object.entries(schema?.properties ?? {});
  if (!entries.length) return <p className="text-[13px] text-muted">Nothing to set for this connector.</p>;
  const required = new Set(schema?.required ?? []);
  const flat: Record<string, JsonSchema> = {};
  const nested: [string, JsonSchema][] = [];
  for (const [key, s] of entries) {
    if (complex(s)) nested.push([key, s]);
    else flat[key] = s;
  }
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const errorAt = (path: string) => {
    const match = Object.entries(errors).find(([k]) => k === path || k.startsWith(`${path}.`));
    return match?.[1];
  };
  return (
    <div className="space-y-4">
      {Object.keys(flat).length > 0 && (
        <SchemaForm
          schema={{ ...schema, properties: flat }}
          value={value}
          onChange={onChange}
          errors={errors}
          prefix={prefix}
          keepHint={keepHint}
          disabled={disabled}
        />
      )}
      {nested.map(([key, s]) => (
        <JsonField
          key={key}
          name={key}
          schema={s}
          value={value[key]}
          onChange={(v) => set(key, v)}
          error={errorAt(`${prefix}.${key}`)}
          required={required.has(key) && !keepHint}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
