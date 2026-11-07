/** Types for test-affected.mjs, so the mapping test can import it (like check-versions.d.mts). */

export const DEFAULT_BASE: string;

export interface Selection {
  /** null runs the whole project; [] selects nothing. */
  files: string[] | null;
  reasons: string[];
}

export interface AffectedResult {
  base: string | null;
  changed: string[];
  full: boolean;
  fullReasons: string[];
  selections: Record<'docs' | 'packages' | 'web' | 'server', Selection>;
  notes: string[];
  suggestions: string[];
}

export interface WorkspacePackage {
  dir: string;
  rel: string;
  pkg: Record<string, unknown>;
}

export function workspacePackages(root: string): Map<string, WorkspacePackage>;

export function selectAffected(options?: { root?: string; files?: string[]; base?: string | null }): AffectedResult;

export function collectChangedFiles(options?: { root?: string; base?: string }): {
  files: string[];
  base: string | null;
  warning: string | null;
};

/** The docs project's test files, or null when the `const docs = [...]` block is not found. */
export function parseDocsProject(source: string): string[] | null;
export function readDocsProject(root?: string): string[] | null;

export function vitestInvocations(result: AffectedResult, passthrough?: string[]): string[][];

export function formatHuman(result: AffectedResult): string;

export function scanImports(source: string): string[];

export function packageNameOf(specifier: string): string | null;

export function resolveSpecifier(root: string, packages: Map<string, WorkspacePackage>, fromFile: string, specifier: string): string | null;
