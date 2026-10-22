import { parseArgs } from 'node:util';
import { migrateAuth } from '@agentic-marketing/auth';
import { newUuid } from '@agentic-marketing/core';
import { migrate } from '@agentic-marketing/db';
import { createServer } from './app';
import { loadConfig } from './config';

// Admin CLI.
//   pnpm cli migrate
//   pnpm cli bootstrap --email you@example.com --password '…' --name 'You' --workspace 'My shop'
const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();
const { db, auth } = createServer(config);

try {
  await migrate(db.admin, { appRolePassword: config.appDbPassword, log: console.log });
  await migrateAuth({ baseUrl: config.publicUrl, secret: config.authSecret, db });

  if (command === 'migrate') {
    console.log('database is up to date');
  } else if (command === 'bootstrap') {
    const { values } = parseArgs({
      args: rest,
      options: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' } },
    });
    if (!values.email || !values.password || !values.workspace) throw new Error('bootstrap needs --email, --password and --workspace');
    const { user } = await auth.api.signUpEmail({
      body: { email: values.email, password: values.password, name: values.name ?? values.email },
    });
    const workspaceId = newUuid();
    await db.admin.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspaceId, values.workspace]);
    await db.admin.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [workspaceId, user.id]);
    console.log(`created workspace "${values.workspace}" (${workspaceId}) with owner ${values.email}`);
  } else {
    console.log('usage: cli migrate | cli bootstrap --email … --password … --workspace … [--name …]');
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
