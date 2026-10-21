declare module 'mjml-browser' {
  const mjml2html: (
    mjml: string,
    options?: Record<string, unknown>,
  ) => { html: string; errors: unknown[] } | Promise<{ html: string; errors: unknown[] }>;
  export default mjml2html;
}
