import { scopedDbName } from './run';

// `node --import tsx packages/db/test/print-db.ts <name>` prints the exact database name the
// harness creates for AM_TEST_RUN, so a shell wrapper can verify and drop the right database.
// A separate entry, so run.ts stays importable from Playwright's CommonJS-loaded configs.
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('usage: node --import tsx packages/db/test/print-db.ts <database-name>');
  process.exit(2);
}
try {
  console.log(scopedDbName(args[0]));
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
}
