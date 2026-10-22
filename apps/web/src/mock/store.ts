import { create } from 'zustand';
import type {
  ApprovalPolicy,
  ApprovalRequest,
  AuditEntry,
  EmailTemplate,
  Experience,
  Journey,
  Profile,
  Segment,
  TrackedEvent,
} from '../api/types';
import {
  seedApprovals,
  seedDaily,
  seedExperiences,
  seedJourneys,
  seedProfiles,
  seedSegments,
  seedTemplates,
} from './seed';

// The mock "backend database". Only api/commands.ts writes to the domain slices;
// screens read from here and call commands, just as they would against the real API.

export type Route = 'overview' | 'journeys' | 'email' | 'live' | 'profiles' | 'analytics' | 'approvals' | 'setup' | 'workspace';

export interface Toast {
  id: number;
  text: string;
  tone: 'good' | 'agent' | 'bad' | 'neutral';
}

interface State {
  route: Route;
  openJourneyId: string | null;
  openProfileId: string | null;
  copilotOpen: boolean;
  approvalPolicy: ApprovalPolicy;

  profiles: Profile[];
  journeys: Journey[];
  segments: Segment[];
  templates: EmailTemplate[];
  experiences: Experience[];
  approvals: ApprovalRequest[];
  audit: AuditEntry[];
  events: TrackedEvent[];
  daily: ReturnType<typeof seedDaily>;
  toasts: Toast[];

  navigate: (route: Route, opts?: { journeyId?: string | null; profileId?: string | null }) => void;
  setCopilotOpen: (open: boolean) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

export const useStore = create<State>((set) => ({
  route: 'overview',
  openJourneyId: null,
  openProfileId: null,
  copilotOpen: false,
  approvalPolicy: 'agent_changes',

  profiles: seedProfiles(),
  journeys: seedJourneys(),
  segments: seedSegments(),
  templates: seedTemplates(),
  experiences: seedExperiences(),
  approvals: seedApprovals(),
  audit: [],
  events: [],
  daily: seedDaily(),
  toasts: [],

  navigate: (route, opts) => {
    set((s) => ({
      route,
      openJourneyId: opts?.journeyId !== undefined ? opts.journeyId : route === 'journeys' ? s.openJourneyId : s.openJourneyId,
      openProfileId: opts?.profileId !== undefined ? opts.profileId : s.openProfileId,
    }));
    try {
      if (location.hash.slice(1) !== route) history.replaceState(null, '', `#${route}`);
    } catch {
      /* sandboxed frames may refuse history changes */
    }
  },
  setCopilotOpen: (copilotOpen) => set({ copilotOpen }),
  toast: (text, tone = 'neutral') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const routes: Route[] = ['overview', 'journeys', 'email', 'live', 'profiles', 'analytics', 'approvals', 'setup', 'workspace'];
