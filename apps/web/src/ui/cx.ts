export function cx(...c: (string | false | null | undefined | 0)[]) {
  return c.filter(Boolean).join(' ');
}
