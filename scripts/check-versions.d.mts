/** Types for check-versions.mjs, so the version test can import it. */
export const SURFACES: [name: string, get: (version: string) => string | undefined][];
export function mismatches(version: string): [name: string, found: string][];
