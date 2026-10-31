#!/usr/bin/env node
// Config as code: keep a workspace's artifacts in git as one JSON file per artifact.
//
//   AM_URL=https://marketing.example.com AM_TOKEN=amk_… scripts/am-config.mjs pull config/
//   scripts/am-config.mjs pull config/ --settings       # also config/_settings.json (non-secret)
//   scripts/am-config.mjs push config/                    # dry run: what would change
//   scripts/am-config.mjs push config/ --apply            # create and update drafts
//   scripts/am-config.mjs push config/ --apply --publish  # and publish (approval policy applies)
//   scripts/am-config.mjs drift config/                   # compare the directory with a workspace
//
// Files are config/<type>/<name>.<id>.json with { id, type, name, content }, plus at most one
// config/_settings.json (name, time zone, approval policy, seed list, autonomy). Renaming a file is
// fine; the id inside decides which artifact it is. Deleting a file deletes nothing remotely.
// Secrets, credentials, API tokens, agents and people are never written.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [command, dir, ...flags] = process.argv.slice(2);
const url = process.env.AM_URL?.replace(/\/$/, '');
const token = process.env.AM_TOKEN;
if (!['pull', 'push', 'drift'].includes(command) || !dir || !url || !token) {
  console.error('usage: AM_URL=… AM_TOKEN=amk_… am-config.mjs pull|push|drift <dir> [--apply] [--publish] [--settings]');
  process.exit(2);
}

async function call(name, input) {
  const res = await fetch(`${url}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${name}: ${body.message ?? res.status}`);
  return body;
}

const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'artifact';

async function files(root) {
  const out = [];
  for (const type of await readdir(root, { withFileTypes: true }).catch(() => []))
    if (type.isDirectory())
      for (const f of await readdir(join(root, type.name))) if (f.endsWith('.json')) out.push(join(root, type.name, f));
  return out;
}

/** Non-secret workspace settings travel as one optional file next to the artifact directories. */
async function readSettings(root) {
  try {
    return JSON.parse(await readFile(join(root, '_settings.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

if (command === 'pull') {
  const bundle = await call('config.export', { includeDrafts: flags.includes('--drafts'), includeSettings: flags.includes('--settings') });
  for (const f of await files(dir)) await rm(f);
  for (const a of bundle.artifacts) {
    await mkdir(join(dir, a.type), { recursive: true });
    const { id, type, name, content } = a;
    await writeFile(join(dir, type, `${slug(name)}.${id}.json`), `${JSON.stringify({ id, type, name, content }, null, 2)}\n`);
  }
  if (bundle.settings) await writeFile(join(dir, '_settings.json'), `${JSON.stringify(bundle.settings, null, 2)}\n`);
  else await rm(join(dir, '_settings.json'), { force: true });
  console.log(`pulled ${bundle.artifacts.length} artifact(s)${bundle.settings ? ' and the workspace settings' : ''} into ${dir}`);
} else {
  const artifacts = await Promise.all((await files(dir)).map(async (f) => JSON.parse(await readFile(f, 'utf8'))));
  const settings = await readSettings(dir);
  const bundle = { format: 'agentic-marketing/artifacts@1', artifacts, ...(settings ? { settings } : {}) };
  const out = await call(command === 'drift' ? 'config.drift' : 'config.import', {
    bundle,
    ...(command === 'drift'
      ? {}
      : {
          dryRun: !flags.includes('--apply'),
          publish: flags.includes('--publish'),
          note: process.env.AM_NOTE ?? `am-config push${process.env.GITHUB_SHA ? ` ${process.env.GITHUB_SHA.slice(0, 7)}` : ''}`,
        }),
  });
  if (command === 'drift') {
    const line = (status, what) => console.log(`${status.padEnd(9)} ${what}`);
    for (const d of out.drift.filter((x) => x.status !== 'unchanged'))
      line(d.status, `${(d.type ?? 'setting').padEnd(15)} ${d.name ?? d.key}`);
    const { create, update, conflict } = out.summary;
    console.log(`${create} to create, ${update} to update, ${conflict} conflict(s), ${out.summary.unchanged} unchanged`);
    if (conflict) process.exitCode = 1;
  } else {
    for (const c of out.changes.filter((x) => x.action !== 'unchanged' || x.publish === 'failed'))
      console.log(
        `${c.action.padEnd(9)} ${c.type.padEnd(15)} ${c.name}${c.publish ? ` → ${c.publish}` : ''}${c.problem ? `: ${c.problem}` : ''}`,
      );
    for (const s of out.settings.filter((x) => x.action !== 'unchanged')) console.log(`update    setting         ${s.key}`);
    const n = out.changes.filter((x) => x.action !== 'unchanged').length + out.settings.filter((x) => x.action !== 'unchanged').length;
    const unchanged = out.changes.length + out.settings.length - n;
    console.log(`${out.dryRun ? 'dry run: ' : ''}${n} change(s), ${unchanged} unchanged`);
    if (out.changes.some((c) => c.publish === 'failed')) process.exitCode = 1;
  }
}
