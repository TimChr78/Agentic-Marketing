import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setCommandTransport, setReadListener } from '../src/app/api';
import {
  createDemoTransport,
  DEMO_ARTIFACTS,
  DEMO_NOW,
  DEMO_PENDING_APPROVALS,
  DEMO_TIME_ZONE,
  DEMO_USER,
  DEMO_WORKSPACE,
  demoNow,
  demoSessionValue,
  installDemoTransport,
} from '../src/features/phase27/integration/demo';

afterEach(() => {
  setCommandTransport(null);
  setReadListener(null);
  vi.unstubAllGlobals();
});

describe('demo transport (#524)', () => {
  it('serves fixture reads and never touches the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const transport = createDemoTransport();

    const workspace = await transport('workspace.get', {});
    const memberships = await transport('workspace.memberships', {});
    const approvals = await transport('approvals.list', { status: 'pending', limit: 200 });
    const artifacts = await transport('artifacts.list', { type: 'email_template', limit: 200 });

    expect(workspace).toEqual(DEMO_WORKSPACE);
    expect(memberships.workspaces[0]?.id).toBe(DEMO_WORKSPACE.id);
    expect(approvals.total).toBe(DEMO_PENDING_APPROVALS.length);
    expect(artifacts.artifacts.length).toBeGreaterThan(0);
    expect(artifacts.artifacts.every((a) => a.type === 'email_template')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses every mutation and keeps the network untouched', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const transport = createDemoTransport();

    await expect(transport('artifacts.create', { type: 'email_template', name: 'Draft', content: {} })).rejects.toMatchObject({
      status: 403,
      code: 'demo_read_only',
    });
    await expect(transport('artifacts.requestPublish', { artifactId: 'x', note: 'demo' })).rejects.toMatchObject({
      code: 'demo_read_only',
    });
    await expect(transport('recipes.install', { recipeId: 'weekly-newsletter', params: {} })).rejects.toMatchObject({
      code: 'demo_read_only',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names an unsupported read instead of inventing a success', async () => {
    const transport = createDemoTransport();
    const error = await transport('recipes.list', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'demo_unavailable' });
    expect((error as Error).message).toContain('demo');
  });

  it('installs behind api.call so the real pages read fixtures without a server', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const uninstall = installDemoTransport();

    const workspace = await api.call('workspace.get', {});
    expect(workspace.name).toBe('MartechSignal');
    expect(workspace.timeZone).toBe(DEMO_TIME_ZONE);
    expect(fetchSpy).not.toHaveBeenCalled();
    uninstall();
    expect(await api.call('workspace.get', {}).catch(() => 'network')).toBe('network');
  });

  it('serves the same fixed-time fixture on every read', async () => {
    const transport = createDemoTransport();
    const first = await transport('artifacts.list', { type: 'broadcast', limit: 200 });
    const second = await transport('artifacts.list', { type: 'broadcast', limit: 200 });
    expect(second).toEqual(first);
    expect(DEMO_ARTIFACTS.every((a) => a.updatedAt <= DEMO_NOW)).toBe(true);
    expect(demoNow().toISOString()).toBe(DEMO_NOW);
  });

  it('builds a ready demo session from the projection, without a real sign-in', () => {
    const session = demoSessionValue();
    expect(session.status).toBe('ready');
    expect(session.user).toEqual(DEMO_USER);
    expect(session.workspace?.name).toBe('MartechSignal');
    expect(session.workspace?.timeZone).toBe(DEMO_TIME_ZONE);
    expect(session.can('artifacts:write')).toBe(true);
    expect(session.can('workspace:admin')).toBe(true);
    expect(session.pending).toBe(DEMO_PENDING_APPROVALS.length);
    expect(session.memberships).toHaveLength(2);
  });
});
