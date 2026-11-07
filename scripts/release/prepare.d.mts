/** Types for prepare.mjs, so the release-tooling tests can import it. */
export function envKeys(text: string): Set<string>;
export function findPreviousVersion(changelog: string, exclude?: string): string | null;
export function migrationsSince(root: string, previous: string): string[];
export function envVarsSince(root: string, previous: string): string[];
export function renderUpgradeBlock(options: { previous: string; version: string; migrations?: string[]; envVars?: string[] }): string;
export function bumpVersions(root: string, version: string): string[];
export function missingEnvHistory(root: string): string[];
export function updateEnvHistory(root: string, version: string): string[];
export function releaseSection(changelog: string, version: string): string | null;
export function upgradeBlockOf(section: string): string | null;
export const UPGRADE_FIELDS: string[];
export function validateUpgradeBlock(block: string | null | undefined): string[];
export function checkRelease(options: { root: string; version: string }): string[];
