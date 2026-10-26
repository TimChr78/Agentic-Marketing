import { parseArgs } from 'node:util';
import {
  backupHealth,
  createBackup,
  listBackups,
  parseKeepDays,
  resolveBackupDir,
  resolveUserPath,
  runScheduledBackups,
} from './backup-lib';

const USAGE = [
  'usage: am backup [--to DIR] [--clickhouse] [--keep-days N]',
  '       am backup --schedule [--clickhouse]',
  '       am backup --list [--dir DIR]',
  '       am backup --health [--dir DIR]',
].join('\n');

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

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function list(dir: string): Promise<number> {
  const backups = await listBackups(dir);
  if (!backups.length) {
    console.log(`no backups in ${dir}`);
    return 0;
  }
  const rows = backups.map((backup) => [
    backup.name,
    backup.kind,
    backup.dataVersion ?? 'unknown',
    backup.migrationHead ?? 'none',
    backup.createdAt,
    humanBytes(backup.bytes),
    backup.clickhouse,
  ]);
  const headers = ['name', 'kind', 'data version', 'migration head', 'created', 'size', 'clickhouse'];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => pad(cell, widths[index])).join('  ');
  console.log(line(headers));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(row));
  return 0;
}

export async function run(args: string[]): Promise<number> {
  // Backups contain subscriber addresses and consent records; keep anything this process creates
  // private even before the explicit chmod calls in backup-lib run.
  process.umask(0o077);

  const options = {
    to: { type: 'string' as const },
    dir: { type: 'string' as const },
    clickhouse: { type: 'boolean' as const },
    'keep-days': { type: 'string' as const },
    schedule: { type: 'boolean' as const },
    list: { type: 'boolean' as const },
    health: { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
  };
  let values: {
    to?: string;
    dir?: string;
    clickhouse?: boolean;
    'keep-days'?: string;
    schedule?: boolean;
    list?: boolean;
    health?: boolean;
    help?: boolean;
  };
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
  if (values.list || values.health) {
    if (values.to || values.schedule || values.clickhouse || values['keep-days'] !== undefined) {
      console.error(`--${values.list ? 'list' : 'health'} only accepts --dir\n${USAGE}`);
      return 2;
    }
    const dir = values.dir ? resolveUserPath(values.dir) : resolveBackupDir();
    if (values.list) return list(dir);
    const health = await backupHealth({ dir });
    console.log(health.reason);
    return health.ok ? 0 : 1;
  }
  if (values.dir) {
    console.error(`--dir is only used with --list or --health; use --to for a backup\n${USAGE}`);
    return 2;
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
    console.log(`  kind ${manifest.kind}, data version ${manifest.fromVersion ?? 'unknown'}, build ${manifest.version}`);
    console.log(`  migration head ${manifest.migrationHead ?? 'none (not migrated)'}`);
    console.log(`  ${manifest.postgres.file}  ${humanBytes(manifest.postgres.bytes)}  sha256 ${manifest.postgres.sha256}`);
    for (const table of manifest.clickhouse?.tables ?? []) {
      const rows = table.files.reduce((sum, file) => sum + file.rows, 0);
      const bytes = table.files.reduce((sum, file) => sum + file.bytes, 0);
      console.log(`  ${table.name}  ${table.files.length} file(s)  ${rows} rows  ${humanBytes(bytes)}`);
      for (const file of table.files)
        console.log(
          `    ${file.file}  ${humanBytes(file.bytes)}  ${file.rows} rows` +
            `${file.workspace ? `  workspace ${file.workspace}` : ''}  sha256 ${file.sha256}`,
        );
    }
    return 0;
  } catch (err) {
    console.error(`backup failed: ${(err as Error).message}`);
    return 1;
  }
}
