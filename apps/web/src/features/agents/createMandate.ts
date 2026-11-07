import { api } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { navigate } from '../../app/router';
import { defaultLevels, type MandateContent } from '../artifacts/MandateEditor';

type Autonomy = Parameters<typeof defaultLevels>[0];

/**
 * Create a draft mandate prefilled for one agent and open it in the editor (#228). The draft grants
 * nothing until a person fills it in and it is published.
 */
export async function createMandateDraft(agent: { id: string; name: string }, autonomy: Autonomy): Promise<void> {
  const content: MandateContent = {
    agent: agent.id,
    purpose: `Act for this workspace on behalf of ${agent.name}, only within the levels, scope and limits a person sets here.`,
    levels: defaultLevels(autonomy),
    scope: { segments: [], purposes: [], topics: [], channels: ['email'], artifactTypes: [], artifacts: [], brand: null },
    limits: {},
    guardrails: { window: 'P7D', minSent: 100 },
    validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    blackoutDates: [],
    holdWindow: 'PT2H',
    escalation: { userIds: [] },
    independentCheck: false,
    goals: [],
  };
  const r = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: `${agent.name} mandate`,
    content: content as never,
    note: `Granted to ${agent.name} from its agent page.`,
  });
  navigate(artifactPath('agent_mandate', r.artifactId));
}
