/**
 * Public links (#1166): the URL a visitor or a third party (Twilio, Shopify, an e-mail provider)
 * must reach, built on the workspace's links URL — its verified primary domain, else the
 * installation's `PUBLIC_LINKS_URL`, including any path prefix such as `/am`. The admin page's own
 * `location.origin` is never it: `/hooks/*` is served only on the links host, and an admin behind
 * Cloudflare Access or Tailscale is not reachable from outside.
 */

/** The links URL without its trailing slashes, so joining a path never doubles them. */
export function linksBase(linksUrl: string): string {
  let end = linksUrl.length;
  while (end > 0 && linksUrl.charCodeAt(end - 1) === 47) end--;
  return linksUrl.slice(0, end);
}

/** A public URL for a server-returned path such as `/hooks/sms/tok/inbound`. */
export function publicLink(linksUrl: string, path: string): string {
  return `${linksBase(linksUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}
