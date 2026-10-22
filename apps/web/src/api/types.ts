// Domain types shared by the UI and the mock backend. In the real platform these come
// from the zod schemas in packages/schema (see docs/architecture/agents-and-mcp.md).

export type Principal = { type: 'user' | 'agent'; name: string };

export type Purpose = 'onboarding' | 'marketing_email' | 'web_personalization' | 'analytics' | 'ai_processing';
export type LawfulBasis = 'consent' | 'legitimate_interest' | 'contract';

export interface ConsentRecord {
  purpose: Purpose;
  channel: 'email' | 'web' | 'any';
  basis: LawfulBasis;
  status: 'granted' | 'denied' | 'objected' | 'not_asked';
  source: string;
  at: number;
}

export interface Profile {
  id: string;
  name: string;
  email?: string;
  anonymousIds: string[];
  city: string;
  country: string;
  traits: Record<string, string | number | boolean>;
  segments: string[];
  consent: ConsentRecord[];
  lastSeen: number;
  ltv: number;
  orders: number;
  journeys: string[];
}

export interface TrackedEvent {
  id: string;
  at: number;
  type: 'track' | 'page' | 'identify';
  name: string;
  anonymousId: string;
  profileId?: string;
  properties: Record<string, unknown>;
  status: 'accepted' | 'dropped_no_consent';
  latencyMs: number;
}

export type NodeKind =
  | 'trigger'
  | 'wait'
  | 'waitEvent'
  | 'branch'
  | 'split'
  | 'email'
  | 'webhook'
  | 'action'
  | 'transform'
  | 'updateProfile'
  | 'aiDecide'
  | 'aiGenerate'
  | 'goal'
  | 'exit';

export interface JourneyNode {
  id: string;
  kind: NodeKind;
  label: string;
  config: Record<string, string | number | boolean>;
  position: { x: number; y: number };
  stats?: { entered: number; active: number };
}

export interface JourneyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface JourneyVersion {
  number: number;
  state: 'draft' | 'in_review' | 'published' | 'superseded';
  author: Principal;
  note: string;
  createdAt: number;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
}

export interface Journey {
  id: string;
  name: string;
  purpose: Purpose;
  status: 'live' | 'paused' | 'draft';
  goal: string;
  versions: JourneyVersion[];
  metrics: { entered: number; active: number; conversion: number; holdoutUplift: number };
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  purpose: Purpose;
  version: number;
  updatedAt: number;
  author: Principal;
  mjml: string;
}

export interface DiffItem {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

export interface ApprovalRequest {
  id: string;
  artifactType: 'journey' | 'template' | 'segment' | 'experience';
  artifactId: string;
  artifactName: string;
  fromVersion?: number;
  toVersion: number;
  requestedBy: Principal;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  summary: string;
  changes: DiffItem[];
}

export interface Segment {
  id: string;
  name: string;
  definition: string;
  size: number;
  realtime: boolean;
  author: Principal;
}

export interface Experience {
  id: string;
  name: string;
  placement: string;
  targeting: string;
  variants: { id: string; name: string; weight: number }[];
  status: 'live' | 'draft';
  exposures: number;
  uplift: number;
}

export type ApprovalPolicy = 'none' | 'agent_changes' | 'all_publishes';

export interface AuditEntry {
  id: string;
  at: number;
  command: string;
  principal: Principal;
  effect: Effect;
  summary: string;
  ok: boolean;
}

export type Effect = 'read' | 'write' | 'publish' | 'send';
