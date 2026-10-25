import { Checkbox, FieldGroup } from '../../ui';
import { SCOPE_TEXT, SCOPES, type Scope } from './scopes';

/** Scopes as checkboxes with what each one lets the token do. Only scopes in `allowed` are offered. */
export function ScopePicker({ value, onChange, allowed, disabled, error }: { value: string[]; onChange: (v: string[]) => void; allowed: string[]; disabled?: boolean; error?: string | null }) {
  const offered = SCOPES.filter((s) => allowed.includes(s) || value.includes(s));
  const usable = offered.filter((s) => !SCOPE_TEXT[s].peopleOnly);
  const peopleOnly = offered.filter((s) => SCOPE_TEXT[s].peopleOnly);
  const row = (s: Scope) => (
    <Checkbox
      key={s}
      label={
        <>
          {SCOPE_TEXT[s].label} <code className="ml-1 font-mono text-[11px] text-muted">{s}</code>
        </>
      }
      hint={`Lets it ${SCOPE_TEXT[s].does}.`}
      checked={value.includes(s)}
      disabled={disabled || !allowed.includes(s)}
      onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))}
    />
  );
  return (
    <FieldGroup legend="Scopes" hint="A token acts as an agent: never more than its owner's role allows, and never what only people may do.">
      {usable.map(row)}
      {peopleOnly.length > 0 && (
        <details className="text-[13px]" open={peopleOnly.some((s) => value.includes(s))}>
          <summary className="cursor-pointer text-muted hover:text-fg">Scopes that give a token nothing ({peopleOnly.length})</summary>
          <div className="mt-2 space-y-3">{peopleOnly.map(row)}</div>
        </details>
      )}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </FieldGroup>
  );
}
