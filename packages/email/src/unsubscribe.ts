import { Parser } from 'htmlparser2';

/**
 * True when the rendered e-mail contains a real link to `url`: an `<a href>` whose value is the
 * rendered unsubscribe URL, in any quoting style. This is the compliance the send gateway actually
 * guarantees: `gateway.ts` puts exactly that URL in the visible link, in `List-Unsubscribe` and in
 * `List-Unsubscribe-Post` for marketing mail. Searching the template source for the variable name
 * was wrong both ways (#637): a footer supplied by a reusable block passed at send time but was
 * blocked at save, and the characters "unsubscribe_url" in prose passed with no link at all.
 */
export function hasUnsubscribeLink(html: string, url: string): boolean {
  const wanted = url.trim();
  if (!wanted) return false;
  let found = false;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (found || name !== 'a') return;
        const href = attribs.href;
        if (href !== undefined && href.trim() === wanted) found = true;
      },
    },
    // Decode entities: the parser then compares the URL a reader would click, not its HTML form.
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return found;
}
