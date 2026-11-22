import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { resolveUserPath, restoreBackup } from './backup-lib';
import { clearRestoreFenceForUrl } from './restore-reconcile';

const USAGE =
  'usage: am restore <backup-dir> [--force] [--clickhouse] [--skip-key-check] [--yes]\n' + '       am restore --clear-fence [--yes]';

export async function run(args: string[]): Promise<number> {
  const options = {
    force: { type: 'boolean' as const },
    clickhouse: { type: 'boolean' as const },
    'skip-key-check': { type: 'boolean' as const },
    'clear-fence': { type: 'boolean' as const },
    yes: { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
  };
  let values: {
    force?: boolean;
    clickhouse?: boolean;
    'skip-key-check'?: boolean;
    'clear-fence'?: boolean;
    yes?: boolean;
    help?: boolean;
  };
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

  if (values['clear-fence']) {
    console.error('--clear-fence removes the fence an unfinished restore left behind. It does NOT reconcile');
    console.error('the restored erasure ledger with ClickHouse: reads may return people whose erasure was');
    console.error('reported complete before the backup, unless the reconciliation already succeeded.');
    console.error('Use it only when you know the exclusions are correct, or accept that they are not.');
    if (!values.yes) {
      if (!process.stdin.isTTY) {
        console.error('Refusing without --yes: there is no terminal to confirm on.');
        return 1;
      }
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await readline.question('Type "clear fence" to continue: ');
        if (answer.trim().toLowerCase() !== 'clear fence') {
          console.error('aborted');
          return 1;
        }
      } finally {
        readline.close();
      }
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error('DATABASE_URL is not set');
      return 1;
    }
    try {
      const cleared = await clearRestoreFenceForUrl(databaseUrl);
      console.log(cleared ? 'restore fence cleared' : 'no restore fence was raised');
      return 0;
    } catch (err) {
      console.error(`could not clear the restore fence: ${(err as Error).message}`);
      return 1;
    }
  }

  const backupDir = positionals[0];
  if (!backupDir) {
    console.error(USAGE);
    return 2;
  }

  console.error('Restore replaces the current Postgres database (and ClickHouse tables with --clickhouse).');
  console.error('Erasures recorded in the live database are replayed afterwards, so people erased since the');
  console.error('backup stay erased. Replaying them applies pending migrations and needs APP_DB_PASSWORD.');
  console.error('Stop the app first: docker compose stop app');
  if (values['skip-key-check'])
    console.error('--skip-key-check: the master key will not be verified; provider and connector secrets may stay unreadable.');
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
      skipKeyCheck: values['skip-key-check'],
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
