/** Types for image-tags.mjs, so the release-tooling tests can import it. */
export function isNewestInLine(version: string, tags: string[]): boolean;
export function imageTagSpec(version: string, tags: string[], options?: { exactOnly?: boolean }): string;
export function parseTags(text: string): string[];
