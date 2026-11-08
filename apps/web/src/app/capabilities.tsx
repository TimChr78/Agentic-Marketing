import { createContext, type ReactNode, useContext } from 'react';

// What the current surface may do. Production leaves the defaults: every capability is available,
// so existing pages and primitives are unchanged. The demo supplies a restricted value once, and
// shared primitives (buttons, the copilot) read it instead of every page branching on demo mode.
//
// The wording is the same refusal the demo transport uses, so a disabled control and a refused
// command explain the limitation identically.

export const DEMO_RESTRICTION_REASON = 'Demo only · changes are unavailable.';

export interface AppCapabilities {
  /** False when this surface must not change data (the demo). */
  mutations: boolean;
  /** False when the streaming assistant must not start a conversation. */
  copilot: boolean;
  /** Why a capability is unavailable; null when everything is available. */
  reason: string | null;
}

const AVAILABLE: AppCapabilities = { mutations: true, copilot: true, reason: null };

const CapabilitiesContext = createContext<AppCapabilities>(AVAILABLE);

export function CapabilitiesProvider({ value, children }: { value: AppCapabilities; children: ReactNode }) {
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): AppCapabilities {
  return useContext(CapabilitiesContext);
}

/** Whether a control that changes data may act, and the reason it cannot. */
export function useMutationsAvailable(): { available: boolean; reason: string | null } {
  const { mutations, reason } = useCapabilities();
  return { available: mutations, reason };
}

/** Whether the streaming copilot may start a conversation, and the reason it cannot. */
export function useCopilotAvailable(): { available: boolean; reason: string | null } {
  const { copilot, reason } = useCapabilities();
  return { available: copilot, reason };
}

/** The value the demo entry installs. Exported so tests can render the same restriction. */
export const DEMO_CAPABILITIES: AppCapabilities = {
  mutations: false,
  copilot: false,
  reason: DEMO_RESTRICTION_REASON,
};
