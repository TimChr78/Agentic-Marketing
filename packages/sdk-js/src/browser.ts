// Entry for the self-contained browser build (dist/am.min.js, global `AgenticMarketing`), for
// sites without a bundler. Host the file yourself, so a strict CSP (script-src 'self') allows it.
export { antiFlickerSnippet, createAnalytics, sanitize } from './index';
