import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, DateTimeInput, Field, FieldGroup, Select, Textarea } from '../../ui';
import { getWorkspaceTimeZone } from '../../ui/time';
import { RefName } from '../previews/FormPreview';
import type { EditorProps } from './ArtifactDetailPage';
import { ArtifactSelect } from './ArtifactSelect';
import { topicsOf } from './PurposesEditor';

interface Broadcast {
  template?: string;
  topic?: string;
  segment?: string;
  sendAt?: string;
  description?: string;
}

/** A broadcast: which template, to which segment, when (in the workspace time zone, #51). */
export function BroadcastEditor({ content, onChange, readOnly, errors }: EditorProps<Broadcast>) {
  const set = (p: Partial<Broadcast>) => onChange(Object.fromEntries(Object.entries({ ...content, ...p }).filter(([, v]) => v !== undefined && v !== '')) as Broadcast);
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const template = useApi(() => api.call('artifacts.get', { artifactId: content.template! }), [content.template], { skip: !content.template });
  const purpose = (template.data?.version.content as { purpose?: string } | undefined)?.purpose;
  const topics = topicsOf(purposes.data?.purposes ?? [], purpose);
  return (
    <div className="max-w-[720px] space-y-5">
      <FieldGroup legend="What and to whom">
        <Field label="Template" error={errors.template} hint="Use one template per issue. It must be live before the broadcast can be published." required>
          <ArtifactSelect type="email_template" value={content.template} onChange={(v) => set({ template: v, topic: undefined })} disabled={readOnly} />
        </Field>
        <Field label="Topic (optional)" error={errors.topic} hint={purpose ? 'A finer choice under the template’s purpose; it overrides the template’s own topic.' : 'Choose a template first.'}>
          <Select value={content.topic ?? ''} disabled={readOnly || topics.length === 0} onChange={(e) => set({ topic: e.target.value || undefined })}>
            <option value="">{topics.length ? 'No topic' : 'No topics'}</option>
            {content.topic && !topics.some((t) => t.key === content.topic) && <option value={content.topic}>{content.topic} (not under this purpose)</option>}
            {topics.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} ({t.key})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Segment" error={errors.segment} hint="Everyone in it who allows the template's purpose gets it; others are skipped." required>
          <ArtifactSelect type="segment" value={content.segment} onChange={(v) => set({ segment: v })} disabled={readOnly} />
        </Field>
      </FieldGroup>
      <FieldGroup legend="When">
        <Field label="Send at" error={errors.sendAt} hint={`In ${getWorkspaceTimeZone()} (Settings → Workspace). Leave empty to send as soon as it is approved.`}>
          <DateTimeInput value={content.sendAt ?? null} onChange={(v) => set({ sendAt: v ?? undefined })} disabled={readOnly} />
        </Field>
        {content.sendAt && new Date(content.sendAt).getTime() < Date.now() && <Alert tone="warn">This time is in the past: it would send as soon as it is published.</Alert>}
      </FieldGroup>
      <Field label="Description" hint="For the team; recipients never see it." error={errors.description}>
        <Textarea rows={2} value={content.description ?? ''} onChange={(e) => set({ description: e.target.value })} readOnly={readOnly} maxLength={500} />
      </Field>
      {content.template && content.segment && (
        <p className="text-[13px] text-muted">
          Sends <RefName id={content.template} /> to <RefName id={content.segment} />.
        </p>
      )}
    </div>
  );
}
