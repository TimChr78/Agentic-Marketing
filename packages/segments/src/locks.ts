// The segment membership lock lives in @agentic-marketing/db so that an erasure (#1197), which
// runs in packages/profiles and cannot import this package (segments depends on profiles), takes
// exactly the same advisory key as every membership writer here. Re-exported unchanged.
export { lockSegmentMemberships, segmentLockKey } from '@agentic-marketing/db';
