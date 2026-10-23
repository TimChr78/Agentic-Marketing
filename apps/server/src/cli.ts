import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { migrateAuth } from '@agentic-marketing/auth';
import { newUuid } from '@agentic-marketing/core';
import { migrate } from '@agentic-marketing/db';
import { migrateClickHouse } from '@agentic-marketing/events';
import { rewrapDataKeys } from '@agentic-marketing/secrets';
import { createServer } from './app';
import { resolvePassword } from './cli-password';
import { loadConfig } from './config';
import { runLoadTest } from './loadtest';

// Admin CLI.
//   pnpm cli migrate
//   pnpm cli bootstrap --email you@example.com --name 'You' --workspace 'My shop'
//   pnpm cli reset-password --email you@example.com
//   pnpm cli rotate-keys    (after setting a new MASTER_KEY and the old one in MASTER_KEY_PREVIOUS, or a new KEY_PROVIDER)
//   pnpm cli loadtest --profiles 1000000 [--keep]   (synthetic data in a throwaway workspace)
// Passwords come from AM_BOOTSTRAP_PASSWORD / AM_RESET_PASSWORD, a hidden terminal prompt, or stdin
// (bootstrap also still accepts --password, with a deprecation warning).
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [command, ...rest] = process.argv.slice(2);
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
  } else {
    console.log(
      'usage: cli migrate | cli bootstrap --email … --workspace … [--name …] | cli reset-password --email … | cli rotate-keys | cli loadtest --profiles N [--keep]',
    );
    console.log(
      'passwords: AM_BOOTSTRAP_PASSWORD / AM_RESET_PASSWORD, a hidden prompt on a terminal, or one line on stdin (--password is deprecated)',
    );
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
