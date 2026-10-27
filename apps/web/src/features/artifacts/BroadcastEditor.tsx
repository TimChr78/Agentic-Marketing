import { Alert, Checkbox, DateTimeInput, Field, FieldGroup, Input, Textarea } from '../../ui';
import { getWorkspaceTimeZone } from '../../ui/time';
import { RefName } from '../previews/FormPreview';
import type { EditorProps } from './ArtifactDetailPage';
import { ArtifactSelect } from './ArtifactSelect';

interface Broadcast {
  template?: string;
  segment?: string;
  sendAt?: string;
  description?: string;
  archive?: { publish?: boolean; slug?: string; summary?: string };
}

/** A broadcast: which template, to which segment, when (in the workspace time zone, #51). */
export function BroadcastEditor({ content, onChange, readOnly, errors }: EditorProps<Broadcast>) {
  const set = (p: Partial<Broadcast>) => onChange(Object.fromEntries(Object.entries({ ...content, ...p }).filter(([, v]) => v !== undefined && v !== '')) as Broadcast);
  return (
    <div className="max-w-[720px] space-y-5">
      <FieldGroup legend="What and to whom">
        <Field label="Template" error={errors.template} hint="Use one template per issue. It must be live before the broadcast can be published." required>
          <ArtifactSelect type="email_template" value={content.template} onChange={(v) => set({ template: v })} disabled={readOnly} />
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
      <FieldGroup
        legend="Newsletter archive"
        hint="After it has been sent, this issue can appear on the workspace archive (Design → Brand → Newsletter archive)."
      >
        <Checkbox
          label="Publish to the archive"
          hint="Only sent issues appear. The page uses the template version that was sent, with empty personalisation."
          checked={content.archive?.publish ?? false}
          disabled={readOnly}
          onChange={(e) => set({ archive: { ...(content.archive ?? {}), publish: e.target.checked } })}
        />
        {content.archive?.publish && (
          <>
            <Field label="Issue address" hint="Optional. Default: the subject plus the send date; lowercase letters, digits and hyphens." error={errors['archive.slug']}>
              <Input
                value={content.archive?.slug ?? ''}
                readOnly={readOnly}
                maxLength={41}
                placeholder="signal-43"
                onChange={(e) => set({ archive: { ...(content.archive ?? {}), slug: e.target.value.toLowerCase() } })}
              />
            </Field>
            <Field label="Summary" hint="Optional. Shown on the archive index and in RSS; default: the template preheader." error={errors['archive.summary']}>
              <Textarea
                rows={2}
                value={content.archive?.summary ?? ''}
                readOnly={readOnly}
                maxLength={500}
                onChange={(e) => set({ archive: { ...(content.archive ?? {}), summary: e.target.value } })}
              />
            </Field>
          </>
        )}
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
