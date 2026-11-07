/** Types for changelog.mjs, so the changelog tests and prepare.mjs can import it. */
export type Section = 'Added' | 'Changed' | 'Fixed' | 'Security' | 'Removed';

export interface Fragment {
  name: string;
  section: string;
  issues: number[];
  text: string;
}

export const SECTIONS: Section[];
export const FRAGMENT_NAME: RegExp;

export function parseFrontMatter(source: string): { data: Record<string, string>; body: string };
export function parseFragment(source: string, name: string): Fragment;
export function readFragments(dir?: string): Fragment[];
export function compareFragments(a: Fragment, b: Fragment): number;
export function checkFragments(fragments: Fragment[]): string[];
export function check(dir?: string): { fragments: Fragment[]; errors: string[] };
export function splitSections(changelog: string): {
  preamble: string;
  sections: { version: string; heading: string; lines: string[] }[];
};
export function renderSection(options: {
  version: string;
  date: string;
  unreleased?: Map<string, string>;
  fragments?: Fragment[];
  upgradeBlock?: string;
}): string;
export function build(options: {
  version: string;
  date?: string;
  dir?: string;
  changelogPath?: string;
  upgradeBlock?: string;
  dryRun?: boolean;
}): { section: string; output: string; consumed: string[] };
