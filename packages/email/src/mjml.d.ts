// The async MJML 5 API we use. mjml ships no types of its own, and @types/mjml is still 4.x, whose
// synchronous signature would hide the missing `await` in our callers.
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
  export default function mjml2html(input: string, options?: MjmlOptions): Promise<{ html: string; errors: MjmlError[] }>;
}
