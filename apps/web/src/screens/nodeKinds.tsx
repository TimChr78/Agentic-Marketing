import {
  Bell,
  Braces,
  Cable,
  Clock,
  Flag,
  GitBranch,
  Hourglass,
  LogOut,
  type LucideIcon,
  Mail,
  MessageSquare,
  Shuffle,
  Sparkles,
  UserCog,
  Wand2,
  Webhook,
  Zap,
} from 'lucide-react';
import type { JourneyNode, NodeKind } from '../api/types';

export const kindMeta: Record<
  NodeKind,
  { label: string; icon: LucideIcon; group: 'Trigger' | 'Flow' | 'Action' | 'AI'; ai?: boolean; defaults: JourneyNode['config'] }
> = {
  trigger: { label: 'Trigger', icon: Zap, group: 'Trigger', defaults: { event: 'signed_up', reentry: 'once' } },
  wait: { label: 'Wait', icon: Clock, group: 'Flow', defaults: { duration: 'P1D' } },
  waitEvent: { label: 'Wait for event', icon: Hourglass, group: 'Flow', defaults: { event: 'email_clicked', timeout: 'P2D' } },
  waitUntil: {
    label: 'Wait until',
    icon: Hourglass,
    group: 'Flow',
    defaults: { condition: { trait: 'plan', op: 'eq', value: 'pro' }, timeout: 'P14D', recheck: 'PT1H' },
  },
  branch: { label: 'Branch', icon: GitBranch, group: 'Flow', defaults: { condition: 'trait.orders_count ≥ 1' } },
  split: { label: 'A/B split', icon: Shuffle, group: 'Flow', defaults: { a: 50, b: 50, holdout: 10 } },
  goal: { label: 'Goal', icon: Flag, group: 'Flow', defaults: { event: 'order_completed', within: 'P14D' } },
  exit: { label: 'Exit', icon: LogOut, group: 'Flow', defaults: {} },
  email: { label: 'Send e-mail', icon: Mail, group: 'Action', defaults: { template: 'tpl_welcome', purpose: 'marketing_email' } },
  sms: { label: 'Send SMS', icon: MessageSquare, group: 'Action', defaults: { template: 'sms_reminder' } },
  push: { label: 'Send push', icon: Bell, group: 'Action', defaults: { template: 'psh_sale' } },
  webhook: { label: 'Webhook', icon: Webhook, group: 'Action', defaults: { url: 'https://hooks.example.com/crm', method: 'POST' } },
  action: { label: 'Connector action', icon: Cable, group: 'Action', defaults: { connection: 'con_slack', action: 'postMessage' } },
  transform: {
    label: 'Transform',
    icon: Braces,
    group: 'Flow',
    defaults: { set: 'total', expression: '$sum(event.properties.products.price)' },
  },
  updateProfile: { label: 'Update profile', icon: UserCog, group: 'Action', defaults: { trait: 'lifecycle_stage', value: 'engaged' } },
  aiDecide: {
    label: 'AI decide',
    icon: Sparkles,
    group: 'AI',
    ai: true,
    defaults: { prompt: 'prm_nba@1', options: 'continue | exit', fallback: 'exit' },
  },
  aiGenerate: {
    label: 'AI generate',
    icon: Wand2,
    group: 'AI',
    ai: true,
    defaults: { slot: 'intro', prompt: 'prm_copy@1', maxChars: 200 },
  },
};

export function configSummary(n: JourneyNode) {
  const c = n.config;
  switch (n.kind) {
    case 'trigger':
      return `on ${c.event}${c.rule ? ` · ${c.rule}` : ''}`;
    case 'wait':
      return String(c.duration);
    case 'waitEvent':
      return `${c.event} · timeout ${c.timeout}`;
    case 'waitUntil':
      return `until match · timeout ${c.timeout}`;
    case 'branch':
      return String(c.condition);
    case 'split':
      return `A ${c.a}% · B ${c.b}%${c.holdout ? ` · holdout ${c.holdout}%` : ''}`;
    case 'email':
      return `${c.template}${c.variant ? ` · variant ${c.variant}` : ''}`;
    case 'sms':
    case 'push':
      return String(c.template);
    case 'aiDecide':
      return `${c.options} · fallback ${c.fallback}`;
    case 'aiGenerate':
      return `slot ${c.slot} · ≤ ${c.maxChars} chars`;
    case 'goal':
      return `${c.event} within ${c.within}`;
    case 'webhook':
      return `${c.method} ${c.url}`;
    case 'updateProfile':
      return `${c.trait} = ${c.value}`;
    case 'action':
      return `${c.action} via ${c.connection}`;
    case 'transform':
      return `vars.${c.set} = ${c.expression}`;
    default:
      return '';
  }
}
