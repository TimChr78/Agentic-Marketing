import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { resolveUserPath, restoreBackup } from './backup-lib';

const USAGE = 'usage: am restore <backup-dir> [--force] [--clickhouse] [--yes]';

export async function run(args: string[]): Promise<number> {
  const options = {
    force: { type: 'boolean' as const },
    clickhouse: { type: 'boolean' as const },
    yes: { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
  };
  let values: { force?: boolean; clickhouse?: boolean; yes?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options, allowPositionals: true }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const backupDir = positionals[0];
  if (!backupDir) {
    console.error(USAGE);
    return 2;
  }

  console.error('Restore replaces the current Postgres database (and ClickHouse tables with --clickhouse).');
  console.error('Erasures recorded in the live database are replayed afterwards, so people erased since the');
  console.error('backup stay erased. Stop the app first: docker compose stop app');
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      console.error('Refusing without --yes: there is no terminal to confirm on.');
      return 1;
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await readline.question('Type "restore" to continue: ');
      if (answer.trim().toLowerCase() !== 'restore') {
        console.error('aborted');
        return 1;
      }
    } finally {
      readline.close();
    }
  }

  try {
    const manifest = await restoreBackup({
      dir: backupDir,
      force: values.force,
      clickhouse: values.clickhouse,
      log: (message) => console.log(message),
    });
    const dataVersion = manifest.format === 1 ? manifest.version : (manifest.fromVersion ?? 'unknown');
    console.log(
      `restored ${manifest.version} from ${resolveUserPath(backupDir)} ` +
        `(snapshot ${manifest.createdAt}, data version ${dataVersion}, migration head ${manifest.migrationHead ?? 'none'})`,
    );
    return 0;
  } catch (err) {
    console.error(`restore failed: ${(err as Error).message}`);
    return 1;
  }
}
