import type { Tone } from '../../ui/display';
import type { BrandScan, ProfilesResult, StatusResult } from './useHomeData';

// The derived setup checklist (#447). Completion is a fact read from current configuration: a
// published brand pointer, a marketing provider, a verified primary domain and at least one
// profile. A missing permission is unknown, never incomplete and never zero. There is no manual
// checkbox, server flag or creation-date heuristic.

export type ChecklistKey = 'brand' | 'email' | 'domain' | 'audience';
export type ChecklistState = 'confirmed' | 'incomplete' | 'checking' | 'failed' | 'restricted';

export interface ChecklistCheck {
  status: ChecklistState;
  /** What makes it complete, e.g. "Published v2". */
  detail?: string;
  /** Why a restricted or failed check cannot be confirmed. */
  reason?: string;
}

export interface ChecklistInput {
  brand: { data: BrandScan | undefined; error: string | null; loading: boolean };
  status: { data: StatusResult | undefined; error: string | null; loading: boolean };
  profiles: { data: ProfilesResult | undefined; error: string | null; loading: boolean };
  domains: readonly { status: string; isPrimary: boolean }[];
  can: (permission: string) => boolean;
}

export interface ChecklistView {
  brand: ChecklistCheck;
  email: ChecklistCheck;
  domain: ChecklistCheck;
  audience: ChecklistCheck;
  confirmed: number;
  allConfirmed: boolean;
  /** True while any required check is still unknown (checking, failed or restricted). */
  hasUnknown: boolean;
}

/** Roles that see the checklist at all. Unknown roles never do. */
export function checklistEligible(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'marketer';
}

export function homeChecklistKey(userId: string, workspaceId: string): string {
  return `am.homeChecklist.${userId}.${workspaceId}.v1`;
}

// localStorage is the device preference; a denied or full store falls back to this tab's memory.
const memory = new Map<string, string>();

export function readChecklistHidden(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'hidden';
  } catch {
    return memory.get(key) === 'hidden';
  }
}

export function hideChecklist(key: string): void {
  memory.set(key, 'hidden');
  try {
    localStorage.setItem(key, 'hidden');
  } catch {
    // The memory copy above still hides it for this tab.
  }
}

export function restoreChecklist(key: string): void {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to remove from the store; the memory copy is gone.
  }
}

const loading = (resource: { data: unknown; error: string | null; loading: boolean }): boolean =>
  resource.data === undefined && resource.error === null;

const failed = (resource: { data: unknown; error: string | null }): boolean => resource.data === undefined && resource.error !== null;

function checkBrand(input: ChecklistInput): ChecklistCheck {
  if (!input.can('artifacts:read'))
    return { status: 'restricted', reason: 'Your role cannot read brand artifacts. Ask an admin to publish the brand.' };
  if (loading(input.brand)) return { status: 'checking' };
  if (failed(input.brand)) return { status: 'failed', reason: input.brand.error ?? 'The brand list could not be read.' };
  if (input.brand.data?.published)
    return {
      status: 'confirmed',
      detail: input.brand.data.publishedVersion ? `Published v${input.brand.data.publishedVersion}` : 'Published',
    };
  return { status: 'incomplete' };
}

function checkEmail(input: ChecklistInput): ChecklistCheck {
  // `system.status` is readable with artifacts:read; the provider settings page is what needs an admin.
  if (!input.can('artifacts:read'))
    return { status: 'restricted', reason: 'Your role cannot read the server status. Ask an admin to configure e-mail.' };
  if (loading(input.status)) return { status: 'checking' };
  if (failed(input.status)) return { status: 'failed', reason: input.status.error ?? 'The server status could not be read.' };
  if (input.status.data?.emailProvider.configured && input.status.data.emailProvider.marketing)
    return { status: 'confirmed', detail: 'Marketing e-mail configured' };
  return { status: 'incomplete' };
}

function checkDomain(input: ChecklistInput): ChecklistCheck {
  // The domain list arrives with the workspace read (artifacts:read); only the editor is admin-gated.
  if (!input.can('artifacts:read'))
    return { status: 'restricted', reason: 'Your role cannot read the workspace domains. Ask an admin to verify a link domain.' };
  if (input.domains.some((domain) => domain.status === 'verified' && domain.isPrimary))
    return { status: 'confirmed', detail: 'Primary link domain verified' };
  return { status: 'incomplete' };
}

function checkAudience(input: ChecklistInput): ChecklistCheck {
  if (!input.can('profiles:read'))
    return { status: 'restricted', reason: 'Ask an admin to add your audience; your role cannot read people.' };
  if (loading(input.profiles)) return { status: 'checking' };
  if (failed(input.profiles)) return { status: 'failed', reason: input.profiles.error ?? 'The audience could not be read.' };
  if ((input.profiles.data?.profiles.length ?? 0) > 0) return { status: 'confirmed', detail: 'People are available' };
  return { status: 'incomplete' };
}

export function checklistView(input: ChecklistInput): ChecklistView {
  const brand = checkBrand(input);
  const email = checkEmail(input);
  const domain = checkDomain(input);
  const audience = checkAudience(input);
  const checks = [brand, email, domain, audience];
  const confirmed = checks.filter((check) => check.status === 'confirmed').length;
  return {
    brand,
    email,
    domain,
    audience,
    confirmed,
    allConfirmed: confirmed === checks.length,
    hasUnknown: checks.some((check) => check.status !== 'confirmed' && check.status !== 'incomplete'),
  };
}

export const CHECKLIST_STATE: Record<Exclude<ChecklistState, 'confirmed'>, { label: string; tone: Tone }> = {
  incomplete: { label: 'To do', tone: 'neutral' },
  checking: { label: 'Checking…', tone: 'neutral' },
  failed: { label: "Couldn't check", tone: 'bad' },
  restricted: { label: 'Ask an admin', tone: 'neutral' },
};

export const CHECKLIST_CONFIRMED = { label: 'Confirmed', tone: 'good' as Tone };
