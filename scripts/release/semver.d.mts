/** Types for semver.mjs, so the release-tooling tests and the release scripts can import it. */
export const SEMVER: RegExp;
export function isSemver(value: unknown): boolean;
export function normalizeVersion(value: unknown): string | null;
export function releaseLine(version: string | null | undefined): string | null;
