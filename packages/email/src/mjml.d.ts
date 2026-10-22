// The synchronous MJML 4 API we use (the repo's @types/mjml-core describe MJML 5).
declare module 'mjml' {
  interface MjmlError {
    line: number;
    message: string;
    tagName: string;
  }
  interface MjmlOptions {
    validationLevel?: 'strict' | 'soft' | 'skip';
    ignoreIncludes?: boolean;
    keepComments?: boolean;
    minify?: boolean;
  }
  export default function mjml2html(input: string, options?: MjmlOptions): { html: string; errors: MjmlError[] };
}
