import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { migrateAuth } from '@agentic-marketing/auth';
import { newUuid } from '@agentic-marketing/core';
import { migrate } from '@agentic-marketing/db';
import { migrateClickHouse } from '@agentic-marketing/events';
import { rewrapDataKeys } from '@agentic-marketing/secrets';
import { createServer } from './app';
import { resolvePassword } from './cli-password';
import { ConfigError, loadConfig } from './config';
import { runLoadTest } from './loadtest';
import { COMMIT, VERSION } from './version';

// Admin CLI.
//   pnpm cli migrate
//   pnpm cli bootstrap --email you@example.com --name 'You' --workspace 'My shop'
//   pnpm cli reset-password --email you@example.com
//   pnpm cli rotate-keys    (after setting a new MASTER_KEY and the old one in MASTER_KEY_PREVIOUS, or a new KEY_PROVIDER)
//   pnpm cli loadtest --profiles 1000000 [--keep]   (synthetic data in a throwaway workspace)
//   pnpm cli init | doctor | smoke | backup | restore   (operations: see src/ops/)
// Passwords come from AM_BOOTSTRAP_PASSWORD / AM_RESET_PASSWORD, a hidden terminal prompt, or stdin
// (bootstrap also still accepts --password, with a deprecation warning).

const GENERAL_USAGE = `usage: am <command> [options]

Commands:
  init            write a .env with fresh secrets and your public URLs
  doctor          check the configuration, services, DNS and egress without changing anything
  smoke           smoke-test a running install from outside
  backup          back up Postgres and the key material
  restore         restore a backup directory
  migrate         apply database migrations
  bootstrap       create the first user and workspace
  reset-password  set a new password for a user
  rotate-keys     re-wrap stored secrets after changing the key provider
  loadtest        load synthetic data into a throwaway workspace
  version         print the version and commit

Run \`am <command> --help\` for a command's options.`;

const ADMIN_USAGE: Record<string, string> = {
  migrate: `usage: am migrate

Applies database migrations and exits. The app does this at start-up unless SKIP_MIGRATIONS=true.`,
  bootstrap: `usage: am bootstrap --email EMAIL --workspace NAME [--name NAME] [--password PASSWORD]

Creates the first user and a workspace, with the user as its owner.
The password comes from AM_BOOTSTRAP_PASSWORD, a hidden terminal prompt, or stdin.`,
  'reset-password': `usage: am reset-password --email EMAIL [--password PASSWORD]

Sets a new password for an existing user.
The password comes from AM_RESET_PASSWORD, a hidden terminal prompt, or stdin.`,
  'rotate-keys': `usage: am rotate-keys

Re-wraps every stored data key with the current key provider or MASTER_KEY.
Set the new key first and keep the old one in MASTER_KEY_PREVIOUS.`,
  loadtest: `usage: am loadtest [--profiles N] [--keep]

Creates synthetic profiles in a throwaway workspace (default: 100000).
Without --keep, the workspace is removed afterwards.`,
};

// Operations run before (or without) migrating: `init` before there is a .env, `backup` and
// `restore` before a migration touches the schema, `doctor` and `smoke` to check an install. Each
// module loads only what it needs.
const operations: Record<string, () => Promise<{ run: (args: string[]) => Promise<number> }>> = {
  init: () => import('./ops/init'),
  doctor: () => import('./ops/doctor'),
  smoke: () => import('./ops/smoke'),
  backup: () => import('./ops/backup'),
  restore: () => import('./ops/restore'),
};

const wantsHelp = (args: string[]) => args.includes('--help') || args.includes('-h');

async function operationHelp(command: string): Promise<boolean> {
  if (!Object.hasOwn(operations, command)) return false;
  const operation = await operations[command]();
  return (await operation.run(['--help'])) === 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // `pnpm cli -- doctor` passes the separator through; Node's own `--` puts it there too.
  if (argv[0] === '--') argv.shift();
  const [command, ...rest] = argv;

  // Help and version need no configuration and no .env: they are what a broken install has left.
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    const target = command === 'help' ? rest[0] : undefined;
    if (!target) {
      console.log(GENERAL_USAGE);
      return 0;
    }
    if (target in ADMIN_USAGE) {
      console.log(ADMIN_USAGE[target]);
      return 0;
    }
    if (await operationHelp(target)) return 0;
    console.error(`am: unknown command "${target}"`);
    console.log(GENERAL_USAGE);
    return 1;
  }
  if (command === 'version' || command === '--version' || command === '-V') {
    console.log(`am ${VERSION}${COMMIT ? ` (${COMMIT})` : ''}`);
    return 0;
  }
  if (!Object.hasOwn(operations, command) && !Object.hasOwn(ADMIN_USAGE, command)) {
    console.error(`am: unknown command "${command}"`);
    console.log(GENERAL_USAGE);
    return 1;
  }

  // An operation's own --help: skip loading .env so a broken environment cannot get in the way.
  if (Object.hasOwn(operations, command) && wantsHelp(rest)) {
    const operation = await operations[command]();
    return operation.run(rest);
  }
  if (Object.hasOwn(ADMIN_USAGE, command) && wantsHelp(rest)) {
    console.log(ADMIN_USAGE[command]);
    return 0;
  }

  try {
    return await dispatch(command, rest);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

async function dispatch(command: string, rest: string[]): Promise<number> {
  // Local runs load the checkout's .env; pnpm leaves INIT_CWD at the directory the user ran from,
  // so `pnpm --filter @agentic-marketing/server cli` and `am` inside the image both work. `init`
  // writes that file and must not fail on a broken one that it is about to replace.
  if (command !== 'init') {
    const envFile = resolve(process.env.INIT_CWD ?? process.cwd(), '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }

  if (Object.hasOwn(operations, command)) {
    const operation = await operations[command]();
    return operation.run(rest);
  }

  await admin(command, rest);
  return 0;
}

async function admin(command: string, rest: string[]) {
  const config = loadConfig();
  const { db, auth, keyProvider, events } = createServer(config);

  try {
    await migrate(db.admin, { appRolePassword: config.appDbPassword, appRole: config.appDbRole, log: console.log });
    await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db });
    await migrateClickHouse(config.clickhouse.url, config.clickhouse.database, console.log, config.clickhouse);

    if (command === 'migrate') {
      console.log('database is up to date');
    } else if (command === 'bootstrap') {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' } },
      });
      if (!values.email || !values.workspace) throw new Error('bootstrap needs --email and --workspace');
      const password = await resolvePassword({
        command: 'bootstrap',
        envVar: 'AM_BOOTSTRAP_PASSWORD',
        passwordFlag: values.password,
      });
      const { user } = await auth.api.signUpEmail({
        body: { email: values.email, password, name: values.name ?? values.email },
      });
      const workspaceId = newUuid();
      await db.admin.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspaceId, values.workspace]);
      await db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [workspaceId, user.id]);
      console.log(`created workspace "${values.workspace}" (${workspaceId}) with owner ${values.email}`);
    } else if (command === 'reset-password') {
      const { values } = parseArgs({ args: rest, options: { email: { type: 'string' }, password: { type: 'string' } } });
      if (!values.email) throw new Error('reset-password needs --email');
      const password = await resolvePassword({
        command: 'reset-password',
        envVar: 'AM_RESET_PASSWORD',
        passwordFlag: values.password,
      });
      const context = await auth.$context;
      const found = await context.internalAdapter.findUserByEmail(values.email, { includeAccounts: true });
      if (!found) throw new Error(`reset-password: no user with email ${values.email}`);
      const hashed = await context.password.hash(password);
      const credential = found.accounts.find((account) => account.providerId === 'credential');
      if (credential) await context.internalAdapter.updateAccount(credential.id, { password: hashed });
      else
        await context.internalAdapter.linkAccount({
          userId: found.user.id,
          providerId: 'credential',
          accountId: found.user.id,
          password: hashed,
        });
      console.log(`password updated for ${values.email}`);
    } else if (command === 'rotate-keys') {
      const { rewrapped } = await rewrapDataKeys(db.admin, keyProvider);
      console.log(`re-wrapped ${rewrapped} data key(s) with ${keyProvider.id}`);
      if (config.keys.provider !== 'local' && config.masterKey)
        console.log(`every data key now uses ${config.keys.provider}; you can remove MASTER_KEY and MASTER_KEY_PREVIOUS`);
      else if (config.previousMasterKeys.length)
        console.log('every data key now uses the current master key; you can remove MASTER_KEY_PREVIOUS');
    } else if (command === 'loadtest') {
      const { values } = parseArgs({ args: rest, options: { profiles: { type: 'string', default: '100000' }, keep: { type: 'boolean' } } });
      const report = await runLoadTest({ db, events }, { profiles: Number(values.profiles), keep: values.keep, log: console.log });
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await db.close();
  }
}

process.exitCode = await main();
