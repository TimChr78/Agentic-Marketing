import { ApiError, type CommandTransport, setCommandTransport } from '../../../../app/api';
import { demoDestinationReads } from '../../demo/reads';
import { DEMO_ARTIFACTS, DEMO_MEMBERSHIPS, DEMO_PENDING_APPROVALS, DEMO_WORKSPACE, DEMO_WORKSPACE_ID } from './fixtures';

// The demo read transport (#524). It is a CommandTransport: the same names and inputs the server
// accepts, answered from the bounded fixture projection. It is installed by the demo entry and
// never falls back to the network. A command it does not serve is refused with an explicit demo
// message, so a page shows its ordinary unavailable state rather than a fake success; every
// mutation is refused unconditionally, independently of whether a control was disabled.
//
// Task D adds the remaining destination reads to `reads`; the guard and the seam stay here.

export type DemoRead<D = unknown> = (input: D) => unknown | Promise<unknown>;

export interface DemoTransportOptions {
  /** The reads the demo serves, keyed by exact command name. Anything else is unavailable. */
  reads?: Record<string, DemoRead>;
  /** Commands that change something; they are always refused, whatever the controls allow. */
  mutations?: Iterable<string>;
}

const READ_ONLY = 'Demo only · changes are unavailable.';
const UNAVAILABLE = 'This is not available in the demo.';

/**
 * The mutations the demo destinations can reach. The guard refuses these even if a control was
 * left enabled; a read the demo does not serve is unavailable instead. D adds destinations, not a
 * second execution engine.
 */
export const DEMO_MUTATIONS: readonly string[] = [
  'artifacts.create',
  'artifacts.updateDraft',
  'artifacts.discardDraft',
  'artifacts.requestPublish',
  'artifacts.requestPublishBundle',
  'artifacts.rename',
  'approvals.decide',
  'approvals.withdraw',
  'recipes.install',
  'templates.test',
  'broadcasts.sendTest',
  'messages.send',
  'agents.run',
  'agents.hostedRun',
  'workspace.setAutonomy',
  'workspace.proposeUpdate',
  'workspace.setSeedList',
  'apiTokens.create',
  'apiTokens.revoke',
  'secrets.set',
  'secrets.delete',
  'emailProviders.create',
  'emailProviders.update',
  'audiences.import',
  'audiences.add',
  'audiences.remove',
  'audiences.refreshSnapshot',
  'assets.upload',
  'assets.update',
  'assets.delete',
  'segments.refresh',
  'consent.record',
  'alerts.create',
  'alerts.update',
  'alerts.delete',
  'journeys.simulate',
  'content.topics.create',
  'content.topics.toBrief',
  'content.topics.archive',
];

/** One page of a fixture list, using the same cursor convention the real list uses. */
function page<T>(rows: T[], input: { limit?: number; cursor?: string }) {
  const limit = Math.max(1, input.limit ?? 50);
  const start = input.cursor ? Number(input.cursor) : 0;
  const offset = Number.isFinite(start) && start > 0 ? start : 0;
  const artifacts = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? String(offset + limit) : null;
  return { artifacts, total: rows.length, nextCursor: next };
}

/** The fixture reads the demo serves today. D extends this record, never the guard. */
export function demoReads(): Record<string, DemoRead<any>> {
  return {
    'workspace.get': () => DEMO_WORKSPACE,
    'workspace.memberships': () => ({ workspaces: DEMO_MEMBERSHIPS }),
    'approvals.list': (input: { status?: string; artifactId?: string; limit?: number }) => {
      const status = input.status ?? 'pending';
      const rows = status === 'pending' ? DEMO_PENDING_APPROVALS.filter((a) => !input.artifactId || a.artifactId === input.artifactId) : [];
      return { approvals: rows.slice(0, input.limit ?? 50), total: rows.length, nextCursor: null };
    },
    'artifacts.list': (input: { type?: string; limit?: number; cursor?: string }) =>
      page(
        DEMO_ARTIFACTS.filter((a) => !input.type || a.type === input.type),
        input,
      ),
    // The reads every demo destination exercises (#530). The guard and the seam originals stay.
    ...demoDestinationReads(),
  };
}

/**
 * Builds the demo transport. Reads come from `reads` (or the built-in projection). Anything not
 * listed as a read is refused as a change when it is a known demo destination, and as unavailable
 * otherwise; neither path calls the network.
 */
export function createDemoTransport(opts: DemoTransportOptions = {}): CommandTransport {
  const reads = opts.reads ?? demoReads();
  const mutations = new Set(opts.mutations ?? DEMO_MUTATIONS);
  return (async (name: string, input: unknown) => {
    const read = reads[name];
    if (read) return read(input);
    // A guarded change is refused even when a control was left enabled; an unknown read names
    // itself unavailable. Neither path can reach the network or invent a success.
    if (mutations.has(name)) throw new ApiError(403, 'demo_read_only', READ_ONLY);
    throw new ApiError(404, 'demo_unavailable', UNAVAILABLE);
  }) as CommandTransport;
}

/** Installs the demo transport behind `api.call`; returns the uninstall. */
export function installDemoTransport(opts: DemoTransportOptions = {}): () => void {
  return setCommandTransport(createDemoTransport(opts));
}

/** Exposed for the mutation guard's own copy, so a refusal reads the same everywhere. */
export const DEMO_READ_ONLY_MESSAGE = READ_ONLY;

/** The workspace id the demo's picker indexes are keyed by. */
export { DEMO_WORKSPACE_ID };
