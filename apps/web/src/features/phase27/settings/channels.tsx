import { MoreHorizontal, Pencil, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, Button, EmptyState, LoadingBlock, Menu, type MenuItem, StatusPill, Switch, Table, Td, THead, Th, Tr } from '../../../ui';

/**
 * One configured provider, described in the words a compact channel row needs. The page that owns
 * the channel supplies the data and the open/edit actions; nothing here reads or writes.
 */
export interface ChannelRow {
  id: string;
  name: string;
  /** The adapter or API style, e.g. "Postmark" or "Anthropic-compatible". */
  adapter: string;
  enabled: boolean;
  /** Enabled/disabled, tracking and any other status words for the row. */
  status: ReactNode;
  /** Where this provider is used, in the channel's own words. */
  summary: ReactNode;
  /** The one secondary line the channel needs, e.g. the sender address. */
  detail?: ReactNode;
  /** A visible warning or one-time hint that belongs to this provider. */
  note?: ReactNode;
  /** Inline controls that sit beside the name, e.g. copying the public key. */
  extras?: ReactNode;
  busy?: boolean;
  onToggle: () => void;
  onEdit: () => void;
  menu?: (MenuItem | 'separator')[];
}

/**
 * One delivery channel: its compact rows plus the states its own read can be in. The channel
 * reports its read separately so one failed channel leaves the other channels usable.
 */
export interface ProviderChannel {
  key: string;
  /** The channel's words, e.g. "E-mail". */
  label: string;
  /** Shown above the channel's rows. */
  description: string;
  addLabel: string;
  onAdd: () => void;
  rows: ChannelRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Empty copy that keeps the existing create flow. */
  empty: ReactNode;
  /** Chatty warnings for the whole channel, e.g. provider tracking overrides. */
  notices?: ReactNode;
  /** Drawers and one-time dialogs this channel owns. */
  overlay?: ReactNode;
}

function RowActions({ row }: { row: ChannelRow }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Switch checked={row.enabled} disabled={row.busy} onChange={row.onToggle} label={`Enable ${row.name}`} hideLabel />
      <Button size="sm" icon={<Pencil size={13} />} onClick={row.onEdit}>
        Edit
      </Button>
      {row.menu?.length ? (
        <Menu
          label={`More for ${row.name}`}
          items={row.menu}
          trigger={(t) => (
            <button
              {...t}
              type="button"
              aria-label={`More actions for ${row.name}`}
              className="inline-flex size-8 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg md:size-7"
            >
              <MoreHorizontal size={16} />
            </button>
          )}
        />
      ) : null}
    </div>
  );
}

/** The desktop half of Providers: one table, grouped by channel so the channel name is not repeated. */
export function ChannelTable({ channels }: { channels: ProviderChannel[] }) {
  return (
    <Table label="Providers">
      <THead>
        <tr>
          <Th>Provider</Th>
          <Th>Status</Th>
          <Th>Used for</Th>
          <Th align="right">Actions</Th>
        </tr>
      </THead>
      {channels.map((channel) => (
        <tbody key={channel.key}>
          <tr className="border-t border-line bg-surface-2">
            <th scope="rowgroup" colSpan={3} className="px-3 py-2 text-left text-[12px] leading-[18px] font-medium text-fg-2 md:px-4">
              {channel.label}
              <span className="ml-2 font-normal text-muted">{channel.description}</span>
            </th>
            <td className="px-3 py-2 text-right md:px-4">
              {!channel.loading && !channel.error && channel.rows.length > 0 && (
                <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={channel.onAdd}>
                  {channel.addLabel}
                </Button>
              )}
            </td>
          </tr>
          {channel.loading && channel.rows.length === 0 ? (
            <tr>
              <Td colSpan={4}>
                <LoadingBlock lines={2} label={`Loading ${channel.label.toLowerCase()} providers`} />
              </Td>
            </tr>
          ) : channel.error ? (
            <tr>
              <Td colSpan={4}>
                <Alert tone="bad" title={`Couldn't load ${channel.label.toLowerCase()} providers`} onRetry={channel.onRetry}>
                  {channel.error}
                </Alert>
                {channel.rows.length > 0 && (
                  <p className="mt-2 text-[12px] text-muted">The values below were loaded before this error and may be out of date.</p>
                )}
              </Td>
            </tr>
          ) : channel.rows.length === 0 ? (
            <tr>
              <Td colSpan={4}>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-fg">Not configured</p>
                    <p className="mt-0.5 text-[12px] text-muted">{channel.empty}</p>
                  </div>
                  <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={channel.onAdd}>
                    {channel.addLabel}
                  </Button>
                </div>
              </Td>
            </tr>
          ) : (
            channel.rows.map((row) => (
              <Tr key={row.id}>
                <Td>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{row.name}</span>
                    <span className="rounded-sm bg-surface-2 px-1.5 py-px text-[11px] text-fg-2">{row.adapter}</span>
                    {row.extras}
                  </div>
                  {row.detail && <div className="mt-0.5 text-[12px] text-muted">{row.detail}</div>}
                  {row.note && <div className="mt-1 text-[12px] text-warn">{row.note}</div>}
                </Td>
                <Td>{row.status}</Td>
                <Td>{row.summary}</Td>
                <Td align="right">
                  <RowActions row={row} />
                </Td>
              </Tr>
            ))
          )}
        </tbody>
      ))}
    </Table>
  );
}

/** The phone half of Providers: the same rows as labelled summaries, never a narrow table. */
export function ChannelCards({ channels }: { channels: ProviderChannel[] }) {
  return (
    <div className="divide-y divide-line">
      {channels.map((channel) => (
        <section key={channel.key} aria-labelledby={`channel-${channel.key}`} className="p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id={`channel-${channel.key}`} className="text-[13px] leading-5 font-semibold">
                {channel.label}
              </h2>
              <p className="text-[12px] leading-[18px] text-muted">{channel.description}</p>
            </div>
            {!channel.loading && !channel.error && channel.rows.length > 0 && (
              <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={channel.onAdd}>
                {channel.addLabel}
              </Button>
            )}
          </div>
          {channel.loading && channel.rows.length === 0 ? (
            <LoadingBlock lines={2} label={`Loading ${channel.label.toLowerCase()} providers`} />
          ) : channel.error ? (
            <Alert tone="bad" title={`Couldn't load ${channel.label.toLowerCase()} providers`} onRetry={channel.onRetry}>
              {channel.error}
            </Alert>
          ) : channel.rows.length === 0 ? (
            <EmptyState
              title="Not configured"
              action={
                <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={channel.onAdd}>
                  {channel.addLabel}
                </Button>
              }
            >
              {channel.empty}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {channel.rows.map((row) => (
                <li key={row.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-fg">{row.name}</span>
                        <span className="rounded-sm bg-surface-2 px-1.5 py-px text-[11px] text-fg-2">{row.adapter}</span>
                        {row.extras}
                      </div>
                      {row.detail && <p className="mt-0.5 text-[12px] text-muted">{row.detail}</p>}
                      {row.note && <p className="mt-1 text-[12px] text-warn">{row.note}</p>}
                    </div>
                    <RowActions row={row} />
                  </div>
                  <dl className="mt-2 grid grid-cols-[minmax(72px,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px] leading-[18px]">
                    <dt className="text-muted">Status</dt>
                    <dd className="min-w-0">{row.status}</dd>
                    <dt className="text-muted">Used for</dt>
                    <dd className="min-w-0">{row.summary}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** A compact status pill that says enabled/disabled in words, never colour alone. */
export function EnabledStatus({ enabled, words }: { enabled: boolean; words?: string }) {
  return <StatusPill tone={enabled ? 'good' : 'neutral'}>{words ?? (enabled ? 'Enabled' : 'Disabled')}</StatusPill>;
}
