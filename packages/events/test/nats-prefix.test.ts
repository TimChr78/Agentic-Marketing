import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { afterAll, describe, expect, it } from 'vitest';
import { runScoped, runScopedFor } from '../../db/test/run';
import { resetNatsNamespace, resetNatsPrefix } from '../src';

// Package tests create their own NATS streams (`am_<run>_test_events_pkg`) that global teardown
// cannot derive from a database name. The run prefix is the authority; a stream from another run
// must survive (#515 review).

const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const base = runScoped('test_nats_prefix');
const other = runScopedFor('otherrun', 'am_test_nats_prefix_keep');

async function streamNames(): Promise<string[]> {
  const nc = await connect({ servers: NATS_URL });
  try {
    const jsm = await jetstreamManager(nc);
    const names: string[] = [];
    for await (const stream of jsm.streams.list()) names.push(stream.config.name);
    return names;
  } finally {
    await nc.close();
  }
}

async function ensureStream(name: string) {
  const nc = await connect({ servers: NATS_URL });
  try {
    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({ name, subjects: [`${name.toLowerCase()}.>`] }).catch(async (error) => {
      if (!/already in use|exists/i.test(String(error))) throw error;
    });
  } finally {
    await nc.close();
  }
}

afterAll(async () => {
  await resetNatsNamespace(NATS_URL, base);
  await resetNatsNamespace(NATS_URL, other);
});

describe('resetting a NATS run prefix', () => {
  it('deletes every stream under the run prefix and leaves another run alone', async () => {
    await resetNatsNamespace(NATS_URL, base);
    await resetNatsNamespace(NATS_URL, other);
    await ensureStream(`${base}_a`.toUpperCase());
    await ensureStream(`${base}_b`.toUpperCase());
    await ensureStream(other.toUpperCase());

    const before = await streamNames();
    expect(before).toEqual(expect.arrayContaining([`${base}_a`.toUpperCase(), `${base}_b`.toUpperCase(), other.toUpperCase()]));

    await resetNatsPrefix(NATS_URL, base);

    const after = await streamNames();
    expect(after).not.toContain(`${base}_a`.toUpperCase());
    expect(after).not.toContain(`${base}_b`.toUpperCase());
    expect(after).toContain(other.toUpperCase());
  }, 20_000);
});
