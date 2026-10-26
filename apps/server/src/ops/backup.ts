import { parseArgs } from 'node:util';
import { createBackup, parseKeepDays, runScheduledBackups } from './backup-lib';

const USAGE = 'usage: am backup [--to DIR] [--clickhouse] [--keep-days N]\n       am backup --schedule [--clickhouse]';

const humanBytes = (bytes: number) => {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};

export async function run(args: string[]): Promise<number> {
  const options = {
    to: { type: 'string' as const },
    clickhouse: { type: 'boolean' as const },
    'keep-days': { type: 'string' as const },
    schedule: { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
  };
  let values: { to?: string; clickhouse?: boolean; 'keep-days'?: string; schedule?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args, options }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.schedule) {
    if (values.to || values['keep-days'] !== undefined) {
      console.error(`--schedule reads BACKUP_DIR and BACKUP_KEEP_DAYS from the environment\n${USAGE}`);
      return 2;
    }
    return runScheduledBackups({ clickhouse: values.clickhouse, log: (message) => console.log(message) });
  }

  try {
    const { dir, manifest } = await createBackup({
      dir: values.to,
      clickhouse: values.clickhouse,
      keepDays: parseKeepDays(values['keep-days']),
      log: (message) => console.log(message),
    });
    console.log(`\nbackup ${dir}`);
    console.log(`  version ${manifest.version}, migration head ${manifest.migrationHead ?? 'none (not migrated)'}`);
    console.log(`  ${manifest.postgres.file}  ${humanBytes(manifest.postgres.bytes)}  sha256 ${manifest.postgres.sha256}`);
    for (const table of manifest.clickhouse?.tables ?? [])
      console.log(`  ${table.file}  ${humanBytes(table.bytes)}  ${table.rows} rows  sha256 ${table.sha256}`);
    return 0;
  } catch (err) {
    console.error(`backup failed: ${(err as Error).message}`);
    return 1;
  }
}
