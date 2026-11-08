// Real-shell demo mode (#524). The public seam for the demo entry: fixture projection, read
// transport, session and copy. `DemoRoot`/`DemoBanner` live in `./DemoRoot` and are imported
// directly by the entry, so this module stays free of React and the real shell.

export {
  DEMO_ARTIFACTS,
  DEMO_MEMBERS,
  DEMO_MEMBERSHIPS,
  DEMO_NOW,
  DEMO_PENDING_APPROVALS,
  DEMO_PEOPLE,
  DEMO_PERMISSIONS,
  DEMO_SANDBOX_ID,
  DEMO_SERVER_VERSION,
  DEMO_TIME_ZONE,
  DEMO_USER,
  DEMO_WORKSPACE,
  DEMO_WORKSPACE_ID,
  type DemoApproval,
  type DemoArtifactRow,
  type DemoMembership,
  type DemoWorkspace,
  demoId,
} from './fixtures';
export { DEMO_BANNER, DEMO_BANNER_HINT, DEMO_TIME_ZONE_LABEL, demoNow, demoSessionValue } from './session';
export {
  createDemoTransport,
  DEMO_MUTATIONS,
  DEMO_READ_ONLY_MESSAGE,
  type DemoRead,
  type DemoTransportOptions,
  demoReads,
  installDemoTransport,
} from './transport';
