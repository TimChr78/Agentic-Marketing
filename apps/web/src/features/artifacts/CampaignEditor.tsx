import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Button, DateTimeInput, Field, FieldGroup, IconButton, Input, Select, Textarea } from '../../ui';
import type { EditorProps } from './ArtifactDetailPage';

// A campaign (#65): a thin parent. The goal says what success means, utmCampaign ties the e-mail
// traffic together, and members are references to work that already exists — nothing is copied or
// executed here.

type GoalKind = 'conversion' | 'revenue' | 'engagement' | 'signups' | 'custom';
type MemberRole = 'primary' | 'follow_up' | 'content';

interface CampaignGoal {
  kind?: GoalKind;
  event?: string;
  target?: number;
  attributionDays?: number;
  [key: string]: unknown;
}

interface CampaignMember {
  artifactId?: string;
  role?: MemberRole;
  [key: string]: unknown;
}

interface CampaignContent {
  description?: string;
  goal?: CampaignGoal;
  utmCampaign?: string;
  members?: CampaignMember[];
  startsAt?: string;
  endsAt?: string;
  [key: string]: unknown;
}

const GOAL_KINDS: { value: GoalKind; label: string }[] = [
  { value: 'conversion', label: 'Conversions: the event fires after a send' },
  { value: 'revenue', label: 'Revenue: value from the conversion event' },
  { value: 'engagement', label: 'Engagement: opens, clicks and visits' },
  { value: 'signups', label: 'Signups: new people' },
  { value: 'custom', label: 'Custom: define it for the team' },
];

const ROLES: { value: MemberRole; label: string }[] = [
  { value: 'primary', label: 'Primary: the main send' },
  { value: 'follow_up', label: 'Follow-up: a later send' },
  { value: 'content', label: 'Content: a shared template or audience' },
];

const MEMBER_TYPE_LABEL: Record<string, string> = {
  broadcast: 'Broadcast',
  journey: 'Journey',
  email_template: 'E-mail template',
  sms_template: 'SMS template',
  push_template: 'Push template',
  experience: 'Experience',
  form: 'Form',
  segment: 'Segment',
};

const MEMBER_PREFIX = /^(bct|jrn|eml|sms|psh|exp|frm|seg)_/;
const UTM_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;

export function CampaignEditor({ content, onChange, readOnly, errors }: EditorProps<CampaignContent>) {
  const set = (patch: Partial<CampaignContent>) => onChange({ ...content, ...patch });
  const goal = content.goal ?? { kind: 'engagement' as const, attributionDays: 7 };
  const setGoal = (patch: Partial<CampaignGoal>) => set({ goal: { ...goal, ...patch } });
  const members = content.members ?? [];
  const artifacts = useApi(() => api.call('artifacts.list', { limit: 200 }), []);
  const choices = (artifacts.data?.artifacts ?? []).filter((a) => MEMBER_PREFIX.test(a.id));
  const setMember = (i: number, patch: Partial<CampaignMember>) =>
    set({ members: members.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const addMember = () => {
    const used = new Set(members.map((m) => m.artifactId));
    const next = choices.find((a) => !used.has(a.id));
    if (next) set({ members: [...members, { artifactId: next.id, role: 'primary' }] });
  };
  const needsEvent = goal.kind === 'conversion' || goal.kind === 'revenue';

  return (
    <div className="max-w-[900px] space-y-5">
      <Field label="Description" hint="What this campaign is for. The team sees it; people never do." error={errors.description}>
        <Textarea rows={2} maxLength={1000} value={content.description ?? ''} readOnly={readOnly} onChange={(e) => set({ description: e.target.value })} />
      </Field>

      <FieldGroup legend="Goal" hint="What the campaign is judged on. Evaluation reads this; it changes nothing about sending.">
        <Field label="Kind" error={errors['goal.kind']} required>
          <Select value={goal.kind ?? 'engagement'} disabled={readOnly} onChange={(e) => setGoal({ kind: e.target.value as GoalKind })}>
            {GOAL_KINDS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </Select>
        </Field>
        {needsEvent && (
          <Field
            label="Conversion event"
            hint="The event that counts, e.g. “Order Completed” or “Subscription Confirmed”."
            error={errors['goal.event']}
            required
          >
            <Input
              value={goal.event ?? ''}
              readOnly={readOnly}
              placeholder="Order Completed"
              onChange={(e) => setGoal({ event: e.target.value || undefined })}
            />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Target" hint="Optional: a count, or revenue in your reporting currency." error={errors['goal.target']}>
            <Input
              type="number"
              min={0}
              value={goal.target ?? ''}
              readOnly={readOnly}
              onChange={(e) => setGoal({ target: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Attribution window"
            hint="How long after a send a conversion still counts."
            unit="days"
            error={errors['goal.attributionDays']}
          >
            <Input
              type="number"
              min={1}
              max={30}
              value={goal.attributionDays ?? 7}
              readOnly={readOnly}
              onChange={(e) => setGoal({ attributionDays: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </div>
      </FieldGroup>

      <FieldGroup legend="Shared UTM campaign">
        <Field
          label="utm_campaign"
          hint="E-mails sent by this campaign’s broadcasts and journeys get this utm_campaign. A template with its own utm.campaign keeps it; the template wins. A template with no UTM settings gets utm_source=newsletter and utm_medium=email."
          error={errors.utmCampaign}
        >
          <Input
            value={content.utmCampaign ?? ''}
            readOnly={readOnly}
            placeholder="autumn-launch"
            spellCheck={false}
            onChange={(e) => set({ utmCampaign: e.target.value.toLowerCase() || undefined })}
          />
        </Field>
        {content.utmCampaign && !UTM_RE.test(content.utmCampaign) && (
          <p className="text-[12px] text-bad">Use lowercase letters, digits, _ and -, starting with a letter or digit (up to 61 characters).</p>
        )}
      </FieldGroup>

      <FieldGroup legend="Dates" hint="Informational: they do not schedule anything. Members keep their own send times.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" error={errors.startsAt}>
            <DateTimeInput value={content.startsAt ?? null} onChange={(v) => set({ startsAt: v ?? undefined })} />
          </Field>
          <Field label="Ends" error={errors.endsAt}>
            <DateTimeInput value={content.endsAt ?? null} onChange={(v) => set({ endsAt: v ?? undefined })} />
          </Field>
        </div>
      </FieldGroup>

      <FieldGroup
        legend="Members"
        hint="Existing broadcasts, journeys, templates, experiences, forms and segments. A sending broadcast or journey can be in only one published campaign; content can be shared."
      >
        {artifacts.error && <p className="text-[12px] text-bad">Couldn’t load artifacts: {artifacts.error}</p>}
        {members.length === 0 ? (
          <p className="text-[12px] text-muted">No members yet. Add the work this campaign groups.</p>
        ) : (
          <ul className="space-y-2">
            {members.map((m, i) => (
              <li key={`${m.artifactId ?? 'new'}-${i}`} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-[minmax(0,1fr)_200px_auto]">
                <Field label="Artifact" hideLabel error={errors[`members.${i}.artifactId`]}>
                  <Select
                    value={m.artifactId ?? ''}
                    disabled={readOnly || artifacts.loading}
                    onChange={(e) => setMember(i, { artifactId: e.target.value })}
                  >
                    <option value="">{artifacts.loading ? 'Loading…' : 'Choose an artifact…'}</option>
                    {m.artifactId && !choices.some((a) => a.id === m.artifactId) && (
                      <option value={m.artifactId}>{m.artifactId} (not found)</option>
                    )}
                    {choices.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {MEMBER_TYPE_LABEL[a.type] ?? a.type}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Role" hideLabel error={errors[`members.${i}.role`]}>
                  <Select value={m.role ?? 'primary'} disabled={readOnly} onChange={(e) => setMember(i, { role: e.target.value as MemberRole })}>
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end">
                  <IconButton
                    label={`Remove member ${m.artifactId ?? i + 1}`}
                    icon={<Trash2 size={14} />}
                    onClick={() => set({ members: members.filter((_, j) => j !== i) })}
                    disabled={readOnly}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button
            variant="secondary"
            icon={<Plus size={14} />}
            onClick={addMember}
            disabled={readOnly || members.length >= 50 || choices.length === 0 || artifacts.loading}
          >
            Add member
          </Button>
          <p className="mt-1 text-[12px] text-muted">{members.length} of 50 members.</p>
        </div>
      </FieldGroup>
    </div>
  );
}

export type { CampaignContent, CampaignGoal, CampaignMember };
