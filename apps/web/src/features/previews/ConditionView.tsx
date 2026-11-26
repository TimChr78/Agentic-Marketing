import { useEffect, useState } from 'react';
import { api, getWorkspaceId } from '../../app/api';
import { Mono } from '../../ui';
import { RefName } from './FormPreview';

// Segment and targeting conditions as readable sentences, nested like the JSON tree.

type Cond = Record<string, unknown>;
const opText: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  exists: 'is set',
  not_exists: 'is not set',
  contains: 'contains',
};
const fmt = (v: unknown) => (Array.isArray(v) ? v.map((x) => JSON.stringify(x)).join(', ') : JSON.stringify(v));
const durationText = (d: string) => {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
  if (!m) return d;
  const [, w, day, h, min] = m;
  const parts = [
    w && `${w} week${w === '1' ? '' : 's'}`,
    day && `${day} day${day === '1' ? '' : 's'}`,
    h && `${h} hour${h === '1' ? '' : 's'}`,
    min && `${min} min`,
  ].filter(Boolean);
  return parts.join(' ') || d;
};

export { durationText };

/** A message engagement condition in words (#441). */
function messageText(event: string): string {
  const text: Record<string, string> = {
    delivered: 'Was delivered a message',
    opened: 'Opened a message',
    clicked: 'Clicked a link in a message',
    bounced: 'Bounced a message',
    complained: 'Marked a message as spam',
    unsubscribed: 'Unsubscribed from a message',
  };
  return text[event] ?? `Had message event ${event}`;
}

// Topic keys live in the purposes artifact; read them once per workspace for the whole preview
// tree (#1263 review). A workspace switch in this tab must not reuse another workspace's names.
let topicNames: { workspaceId: string | null; names: Map<string, string> } | null = null;
let topicNamesRead: { workspaceId: string | null; read: Promise<Map<string, string>> } | null = null;

function readTopicNames(): Promise<Map<string, string>> {
  const workspaceId = getWorkspaceId();
  if (topicNames?.workspaceId === workspaceId) return Promise.resolve(topicNames.names);
  if (topicNamesRead?.workspaceId === workspaceId) return topicNamesRead.read;
  const read = api
    .call('purposes.list', {})
    .then((r) => {
      const names = new Map(r.purposes.flatMap((purpose) => (purpose.topics ?? []).map((topic) => [topic.key, topic.name] as const)));
      topicNames = { workspaceId, names };
      return names;
    })
    .catch((error) => {
      if (topicNamesRead?.read === read) topicNamesRead = null;
      throw error;
    });
  topicNamesRead = { workspaceId, read };
  return read;
}

/** A topic a person subscribed to, by its name; a failed lookup never prints the raw key. */
function TopicName({ topic }: { topic: string }) {
  const [state, setState] = useState<{ name?: string; status: 'loading' | 'ready' | 'error' }>(() =>
    topicNames?.workspaceId === getWorkspaceId() ? { name: topicNames.names.get(topic), status: 'ready' } : { status: 'loading' },
  );
  useEffect(() => {
    let live = true;
    setState((current) => (current.status === 'ready' && current.name ? current : { status: 'loading' }));
    readTopicNames()
      .then((names) => live && setState({ name: names.get(topic), status: 'ready' }))
      .catch(() => live && setState({ status: 'error' }));
    return () => {
      live = false;
    };
  }, [topic]);
  if (state.status === 'loading') return <span className="text-muted">Loading topic…</span>;
  if (!state.name) return <span className="text-muted">Unavailable topic</span>;
  return <strong className="font-medium">{state.name}</strong>;
}

export function ConditionView({ condition, depth = 0 }: { condition: unknown; depth?: number }) {
  const c = (condition ?? {}) as Cond;
  if (Array.isArray(c.all) || Array.isArray(c.any)) {
    const list = (c.all ?? c.any) as unknown[];
    const word = c.all ? 'All of' : 'Any of';
    return (
      <div className={depth ? 'rounded-md border border-line p-2.5' : ''}>
        <p className="text-[12px] font-medium text-muted">{word}</p>
        <ul className="mt-1.5 space-y-1.5 border-l-2 border-line pl-3">
          {list.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: previewed conditions are plain nested objects with no id; position is their identity
            <li key={i}>
              <ConditionView condition={x} depth={depth + 1} />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (c.not !== undefined)
    return (
      <div>
        <p className="text-[12px] font-medium text-muted">Not</p>
        <div className="mt-1 border-l-2 border-line pl-3">
          <ConditionView condition={c.not} depth={depth + 1} />
        </div>
      </div>
    );
  if (typeof c.trait === 'string')
    return (
      <p className="text-[13px]">
        Trait <Mono>{c.trait}</Mono> {opText[String(c.op)] ?? String(c.op)}{' '}
        {c.value !== undefined && <strong className="font-medium">{fmt(c.value)}</strong>}
      </p>
    );
  if (typeof c.event === 'string') {
    const count = c.count as { gte?: number; lte?: number } | undefined;
    const where = c.where as Record<string, unknown> | undefined;
    return (
      <p className="text-[13px]">
        Did <strong className="font-medium">{c.event}</strong>
        {where && Object.keys(where).length > 0 && (
          <>
            {' '}
            where{' '}
            {Object.entries(where)
              .map(([k, v]) => `${k} = ${fmt(v)}`)
              .join(' and ')}
          </>
        )}
        {count?.gte !== undefined && <> at least {count.gte} times</>}
        {count?.lte !== undefined && <> at most {count.lte} times</>}
        {typeof c.within === 'string' && <> in the last {durationText(c.within)}</>}
      </p>
    );
  }
  if (typeof c.message === 'string') {
    const count = c.count as { gte?: number; lte?: number } | undefined;
    const channel = typeof c.channel === 'string' ? c.channel : undefined;
    return (
      <p className="text-[13px]">
        {messageText(c.message)}
        {channel && <> by {channel === 'email' ? 'e-mail' : channel}</>}
        {typeof c.purpose === 'string' && (
          <>
            {' '}
            for <Mono>{c.purpose}</Mono>
          </>
        )}
        {count?.gte !== undefined && count.gte !== 1 && <> at least {count.gte} messages</>}
        {count?.lte !== undefined && <> at most {count.lte} messages</>}
        {typeof c.within === 'string' ? (
          <> in the last {durationText(c.within)}</>
        ) : (
          <> in the last 25 months (how long message history is kept)</>
        )}
        {typeof c.broadcast === 'string' && (
          <>
            {' '}
            from broadcast <RefName id={c.broadcast} />
          </>
        )}
        {typeof c.journey === 'string' && (
          <>
            {' '}
            from journey <RefName id={c.journey} />
          </>
        )}
      </p>
    );
  }
  if (typeof c.topic === 'string')
    return (
      <p className="text-[13px]">
        Subscribed to topic <TopicName topic={c.topic} />
      </p>
    );
  if (c.score && typeof c.score === 'object') {
    const score = c.score as { key?: unknown; gte?: unknown; lte?: unknown };
    const gte = typeof score.gte === 'number' ? score.gte : undefined;
    const lte = typeof score.lte === 'number' ? score.lte : undefined;
    return (
      <p className="text-[13px]">
        Score <Mono>{String(score.key ?? '')}</Mono>
        {gte !== undefined && (
          <>
            {' '}
            is at least <strong className="font-medium">{gte}</strong>
          </>
        )}
        {gte !== undefined && lte !== undefined && ' and'}
        {lte !== undefined && (
          <>
            {' '}
            is at most <strong className="font-medium">{lte}</strong>
          </>
        )}
      </p>
    );
  }
  if (typeof c.consent === 'string')
    return (
      <p className="text-[13px]">
        Allows <Mono>{c.consent}</Mono>
      </p>
    );
  if (typeof c.segment === 'string')
    return (
      <p className="text-[13px]">
        Is in segment <RefName id={c.segment} />
      </p>
    );
  if (typeof c.session === 'string')
    return (
      <p className="text-[13px]">
        Did <strong className="font-medium">{c.session}</strong> this session
      </p>
    );
  if (c.page)
    return (
      <p className="text-[13px]">
        Page matches <Mono>{JSON.stringify(c.page)}</Mono>
      </p>
    );
  if (c.device) return <p className="text-[13px]">Device is {String(c.device)}</p>;
  if (c.newVisitor !== undefined) return <p className="text-[13px]">{c.newVisitor ? 'New visitor' : 'Returning visitor'}</p>;
  if (c.referrer) return <p className="text-[13px]">Referrer contains {fmt((c.referrer as Cond).contains)}</p>;
  if (c.utmSource) return <p className="text-[13px]">UTM source is {fmt(c.utmSource)}</p>;
  return <Mono>{JSON.stringify(c)}</Mono>;
}
