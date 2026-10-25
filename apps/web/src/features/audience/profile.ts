import type { Out } from '../../app/api';

// Small profile helpers shared by the people list and the person page.

export type Person = Out<'profiles.get'>;

/** The e-mail address when the API returned it in clear, else null (hidden without profiles:pii). */
export function visibleEmail(p: Person | undefined): string | null {
  const email = p?.personal.email;
  return typeof email === 'string' && email !== '[hidden]' ? email : null;
}

/** A person's e-mail if visible, otherwise a short profile id. */
export function personLabel(p: Person | undefined, id: string): string {
  return visibleEmail(p) ?? `${id.slice(0, 16)}…`;
}
