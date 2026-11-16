#!/usr/bin/env node
// List Playwright tests that passed only on retry in the job summary. CI runs Playwright with
// retries: 1; without this step a flake looks like a pass and is never tracked (#990).
//
// The JSON reporter writes the report at `reports/playwright.json` (playwright.config.ts).
// Reads it after the run and appends a Markdown section to $GITHUB_STEP_SUMMARY.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const reportPath = process.env.PLAYWRIGHT_JSON ?? 'reports/playwright.json';
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

function summary(markdown) {
  process.stdout.write(`${markdown}\n`);
  if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
}

if (!existsSync(reportPath)) {
  summary(
    '### Playwright retries\n\nNo JSON report was written, so tests that needed a retry could not be listed. ' +
      'Check that the e2e step ran playwright.config.ts with CI set.\n',
  );
  process.exit(0);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const flaky = [];

/** The reporter nests specs under suites, and may merge suites from several projects. */
function walk(suites, trail = []) {
  for (const suite of suites ?? []) {
    const path = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== 'flaky') continue;
        const failing = (test.results ?? []).find((result) => result.status !== 'passed' && result.status !== 'skipped');
        const retried = (test.results ?? []).filter((result) => result.retry > 0);
        const firstError = failing?.error?.message?.split('\n')[0] ?? 'first attempt failed';
        flaky.push({
          project: test.projectName,
          title: [...path, spec.title].filter(Boolean).join(' › '),
          file: spec.file,
          line: spec.line,
          error: firstError,
          retries: retried.length,
        });
      }
    }
    walk(suite.suites, path);
  }
}

walk(report.suites);
const stats = report.stats ?? {};

if (!flaky.length) {
  summary(`### Playwright retries\n\n${stats.flaky ? `${stats.flaky} flaky test(s) reported.` : 'No test needed a retry.'}\n`);
  process.exit(0);
}

const lines = [
  '### Playwright retries',
  '',
  `**${flaky.length} test(s) passed only on retry.** ${(stats.unexpected ?? 0) > 0 ? `${stats.unexpected} other test(s) failed on every attempt; see the failures above.` : 'Nothing else failed in this run.'} Each flaky test will need a rerun again; treat it as a bug.`,
  '',
  '| Project | Test | File | First attempt |',
  '|---|---|---|---|',
  ...flaky.map((f) => `| ${f.project} | ${f.title.replaceAll('|', '\\|')} | \`${f.file}:${f.line}\` | ${f.error.replaceAll('|', '\\|')} |`),
  '',
  `Retries: ${stats.flaky ?? flaky.length} flaky, ${stats.unexpected ?? 0} unexpected, ${stats.expected ?? 0} expected.`,
];

if (stats.unexpected) lines.push('', 'Some tests still failed after the retry; see the Playwright report.');
summary(lines.join('\n'));
