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
