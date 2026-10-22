import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { NATS_URL, SHARDS, STREAM, type BusEvent } from './common';

// Per-profile ordering check, as the profile/segment/journey workers need it: one consumer per
// shard subject, messages handled strictly one after another. Counts any event whose per-profile
// seq is not exactly last+1.
const nc = await connect({ servers: NATS_URL });
const js = jetstream(nc);
const dec = new TextDecoder();
const last = new Map<string, number>();
let processed = 0;
let violations = 0;
let stopping = false;
process.on('message', (m: { cmd: string }) => {
  if (m.cmd === 'stop') stopping = true;
});

await Promise.all(
  Array.from({ length: SHARDS }, async (_, shard) => {
    const consumer = await js.consumers.get(STREAM, `ordered-${shard}`);
    while (!stopping) {
      const batch = await consumer.fetch({ max_messages: 1000, expires: 1000 });
      for await (const m of batch) {
        const e = JSON.parse(dec.decode(m.data)) as BusEvent;
        const prev = last.get(e.anonymousId) ?? 0;
        if (e.seq !== prev + 1) violations++;
        last.set(e.anonymousId, Math.max(prev, e.seq));
        processed++;
        m.ack();
      }
    }
  }),
);
process.send?.({ type: 'done', processed, profiles: last.size, violations });
await nc.close();
