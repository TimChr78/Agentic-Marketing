import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type Check, checkConfig, envFileChecks, liveChecks, offlineChecks } from './checks';

// `am doctor`: check this install without changing it. Offline checks always run; live checks run
// only when the configuration is valid, and every network operation has a short timeout.

const TEMPLATE = new URL('../../../../.env.example', import.meta.url);

function printTable(checks: Check[]) {
  const statusWidth = Math.max('STATUS'.length, ...checks.map((check) => check.status.length));
  const idWidth = Math.max('CHECK'.length, ...checks.map((check) => check.id.length));
  const row = (status: string, id: string, message: string, hint = '') =>
    `${status.padEnd(statusWidth)}  ${id.padEnd(idWidth)}  ${message}${hint ? `  (${hint})` : ''}`;
  console.log(row('STATUS', 'CHECK', 'MESSAGE', 'HINT'));
  for (const check of checks) console.log(row(check.status, check.id, check.message, check.hint));
  const count = (status: Check['status']) => checks.filter((check) => check.status === status).length;
  console.log(`\n${count('ok')} ok, ${count('warn')} warning(s), ${count('fail')} failure(s)`);
}

export async function run(args: string[]): Promise<number> {
  let values: { json?: boolean; 'env-file'?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        json: { type: 'boolean' },
        'env-file': { type: 'string' },
      },
    }));
  } catch (err) {
    console.error(`am doctor: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const checks = offlineChecks(process.env);

  const envFile = values['env-file']?.trim();
  if (envFile) {
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), envFile);
    try {
      const [file, example] = await Promise.all([readFile(path, 'utf8'), readFile(fileURLToPath(TEMPLATE), 'utf8')]);
      checks.push(...envFileChecks(file, example));
    } catch (err) {
      checks.push({
        id: 'env-file',
        status: 'fail',
        message: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'Pass a path to an existing .env file.',
      });
    }
  }

  const config = checkConfig(process.env);
  checks.push(config.check);
  if (config.config) checks.push(...(await liveChecks(config.config)));

  if (values.json) console.log(JSON.stringify(checks, null, 2));
  else printTable(checks);

  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
