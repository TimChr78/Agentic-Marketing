export type ChatItem =
  | { id: string; role: 'user' | 'assistant'; text: string; actions?: { label: string; run: () => void }[] }
  | { id: string; role: 'tool'; name: string; input: unknown; output?: unknown; error?: string; status: 'running' | 'done' | 'error' };

export interface LiveConfig {
  provider: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Sink {
  say: (text: string, actions?: { label: string; run: () => void }[]) => void;
  tool: (name: string, input: unknown) => Promise<unknown>;
}
