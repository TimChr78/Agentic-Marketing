import {
  Blocks,
  ClipboardList,
  FileText,
  Library,
  ListFilter,
  type LucideIcon,
  Mail,
  PanelsTopLeft,
  Send,
  Target,
  Workflow,
} from 'lucide-react';

// The New menu and command palette share one creation list (#446): exact order, type and icon.
// Selecting one never creates anything by itself; it opens the existing create flow on the family's
// canonical list with `?create=<type>`, and that page opens its dialog once and consumes the intent.

export interface CreateAction {
  /** Artifact type the existing create flow uses. */
  type: string;
  /** Label in the New menu. */
  label: string;
  /** Label in the command palette, where the group already says Create. */
  paletteLabel: string;
  icon: LucideIcon;
  /** Canonical list URL, including the destination tab when the family lives in a tab. */
  to: string;
}

export const CREATE_ACTIONS: CreateAction[] = [
  {
    type: 'broadcast',
    label: 'Broadcast',
    paletteLabel: 'New broadcast',
    icon: Send,
    to: '/marketing/broadcasts?create=broadcast',
  },
  {
    type: 'campaign',
    label: 'Campaign',
    paletteLabel: 'New campaign',
    icon: Target,
    to: '/marketing/campaigns?create=campaign',
  },
  {
    type: 'journey',
    label: 'Journey',
    paletteLabel: 'New journey',
    icon: Workflow,
    to: '/marketing/journeys?create=journey',
  },
  {
    type: 'experience',
    label: 'Web experience',
    paletteLabel: 'New web experience',
    icon: PanelsTopLeft,
    to: '/marketing/experiences?create=experience',
  },
  {
    type: 'segment',
    label: 'Segment',
    paletteLabel: 'New segment',
    icon: ListFilter,
    to: '/audience/segments?create=segment',
  },
  {
    type: 'form',
    label: 'Signup form',
    paletteLabel: 'New signup form',
    icon: ClipboardList,
    to: '/audience/forms?create=form',
  },
  {
    type: 'email_template',
    label: 'E-mail template',
    paletteLabel: 'New e-mail template',
    icon: Mail,
    to: '/content/templates?create=email_template',
  },
  {
    type: 'email_block',
    label: 'E-mail block',
    paletteLabel: 'New e-mail block',
    icon: Blocks,
    to: '/content/templates?tab=blocks&create=email_block',
  },
  {
    type: 'prompt',
    label: 'AI prompt',
    paletteLabel: 'New AI prompt',
    icon: FileText,
    to: '/work/agents?tab=library&create=prompt',
  },
];

export const STARTER_ACTION = {
  label: 'From a starter…',
  paletteLabel: 'From a starter…',
  icon: Library,
  to: '/create?tab=starters',
} as const;

const CREATE_TYPES = new Set(CREATE_ACTIONS.map((a) => a.type));

/** A known create type from the URL, or null. Pure so route fixtures and tests can share it. */
export function parseCreateIntent(search: URLSearchParams): string | null {
  const value = search.get('create');
  return value && CREATE_TYPES.has(value) ? value : null;
}

/** The action for one artifact type, used where a page knows what it can create. */
export function createAction(type: string): CreateAction | undefined {
  return CREATE_ACTIONS.find((a) => a.type === type);
}
