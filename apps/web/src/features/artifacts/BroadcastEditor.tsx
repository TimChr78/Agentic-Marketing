import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Checkbox, DateTimeInput, Field, FieldGroup, Input, Select, Textarea } from '../../ui';
import { getWorkspaceTimeZone } from '../../ui/time';
import { RefName } from '../previews/FormPreview';
import type { EditorProps } from './ArtifactDetailPage';
import { ArtifactSelect } from './ArtifactSelect';
import { topicsOf } from './PurposesEditor';

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

interface SubjectTest {
  subjects: string[];
  samplePercent: number;
  metric: 'click' | 'open';
  decideAfter: string;
}

interface SendWindow {
  start: string;
  end: string;
  days?: Weekday[];
  maxDelay?: string;
}

interface Broadcast {
  template?: string;
  topic?: string;
  segment?: string;
  sendAt?: string;
  subjectTest?: SubjectTest;
  sendWindow?: SendWindow;
  description?: string;
  archive?: { publish?: boolean; slug?: string; summary?: string };
}

const DAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const DEFAULT_WINDOW: SendWindow = { start: '09:00', end: '17:00', maxDelay: 'P1D' };
const DEFAULT_TEST: SubjectTest = { subjects: ['', ''], samplePercent: 20, metric: 'click', decideAfter: 'PT4H' };

/** A broadcast: which template, to which segment, when and in whose local time, and an optional subject test. */
export function BroadcastEditor({ content, onChange, readOnly, errors }: EditorProps<Broadcast>) {
  const set = (p: Partial<Broadcast>) =>
    onChange(Object.fromEntries(Object.entries({ ...content, ...p }).filter(([, v]) => v !== undefined && v !== '')) as Broadcast);
  const purposes = useApi(() => api.call('purposes.list', {}), []);
  const template = useApi(() => api.call('artifacts.get', { artifactId: content.template! }), [content.template], {
    skip: !content.template,
  });
  const purpose = (template.data?.version.content as { purpose?: string } | undefined)?.purpose;
  const topics = topicsOf(purposes.data?.purposes ?? [], purpose);
  const test = content.subjectTest;
  const setTest = (p: Partial<SubjectTest>) => set({ subjectTest: { ...(test ?? DEFAULT_TEST), ...p } });
  const window = content.sendWindow;
  const setWindow = (p: Partial<SendWindow>) => set({ sendWindow: { ...(window ?? DEFAULT_WINDOW), ...p } });
  const toggleDay = (day: Weekday) => {
    const days = window?.days ?? [];
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    // No days means every day; all seven is the same thing, so keep the stored value simple.
    setWindow({ days: next.length === 0 || next.length === 7 ? undefined : next });
  };
  const setSubject = (i: number, value: string) => setTest({ subjects: (test?.subjects ?? []).map((s, j) => (j === i ? value : s)) });
  const addSubject = () => setTest({ subjects: [...(test?.subjects ?? []), ''] });
  const removeSubject = (i: number) => setTest({ subjects: (test?.subjects ?? []).filter((_, j) => j !== i) });

  return (
    <div className="max-w-[720px] space-y-5">
      <FieldGroup legend="What and to whom">
        <Field
          label="Template"
          error={errors.template}
          hint="Use one template per issue. It must be live before the broadcast can be published."
          required
        >
          <ArtifactSelect
            type="email_template"
            value={content.template}
            onChange={(v) => set({ template: v, topic: undefined })}
            disabled={readOnly}
          />
        </Field>
        <Field
          label="Topic (optional)"
          error={errors.topic}
          hint={
            purpose ? 'A finer choice under the template’s purpose; it overrides the template’s own topic.' : 'Choose a template first.'
          }
        >
          <Select
            value={content.topic ?? ''}
            disabled={readOnly || topics.length === 0}
            onChange={(e) => set({ topic: e.target.value || undefined })}
          >
            <option value="">{topics.length ? 'No topic' : 'No topics'}</option>
            {content.topic && !topics.some((t) => t.key === content.topic) && (
              <option value={content.topic}>{content.topic} (not under this purpose)</option>
            )}
            {topics.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} ({t.key})
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Segment"
          error={errors.segment}
          hint="Everyone in it who allows the template's purpose gets it; others are skipped."
          required
        >
          <ArtifactSelect type="segment" value={content.segment} onChange={(v) => set({ segment: v })} disabled={readOnly} />
        </Field>
      </FieldGroup>

      <FieldGroup legend="When">
        <Field
          label="Send at"
          error={errors.sendAt}
          hint={`In ${getWorkspaceTimeZone()} (Settings → Workspace). Leave empty to send as soon as it is approved.`}
        >
          <DateTimeInput value={content.sendAt ?? null} onChange={(v) => set({ sendAt: v ?? undefined })} disabled={readOnly} />
        </Field>
        {content.sendAt && new Date(content.sendAt).getTime() < Date.now() && (
          <Alert tone="warn">This time is in the past: it would send as soon as it is published.</Alert>
        )}
        <Checkbox
          label="Only send inside a local-time window"
          hint="Each reader gets it only between these times in their own time zone; others wait for the next opening."
          checked={!!window}
          disabled={readOnly}
          onChange={(e) => set({ sendWindow: e.target.checked ? DEFAULT_WINDOW : undefined })}
        />
        {window && (
          <div className="space-y-4 rounded-md border border-line p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Window opens" error={errors['sendWindow.start']}>
                <Input type="time" value={window.start} onChange={(e) => setWindow({ start: e.target.value })} readOnly={readOnly} />
              </Field>
              <Field label="Window closes" error={errors['sendWindow.end']} hint="May cross midnight, e.g. 22:00–02:00.">
                <Input type="time" value={window.end} onChange={(e) => setWindow({ end: e.target.value })} readOnly={readOnly} />
              </Field>
            </div>
            <Field label="Days" hint="In the reader's time zone. None selected means every day.">
              <div className="flex flex-wrap gap-3">
                {DAYS.map((d) => (
                  <Checkbox
                    key={d.key}
                    label={d.label}
                    checked={(window.days ?? []).includes(d.key)}
                    disabled={readOnly}
                    onChange={() => toggleDay(d.key)}
                  />
                ))}
              </div>
            </Field>
            <Field
              label="Longest wait"
              error={errors['sendWindow.maxDelay']}
              hint="An ISO 8601 duration, e.g. P1D. Someone whose next window is later than the send time plus this is skipped and counted."
            >
              <Input
                value={window.maxDelay ?? 'P1D'}
                onChange={(e) => setWindow({ maxDelay: e.target.value })}
                readOnly={readOnly}
                placeholder="P1D"
              />
            </Field>
          </div>
        )}
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
            <Field
              label="Issue address"
              hint="Optional. Default: the subject plus the send date; lowercase letters, digits and hyphens."
              error={errors['archive.slug']}
            >
              <Input
                value={content.archive?.slug ?? ''}
                readOnly={readOnly}
                maxLength={41}
                placeholder="signal-43"
                onChange={(e) => set({ archive: { ...(content.archive ?? {}), slug: e.target.value.toLowerCase() } })}
              />
            </Field>
            <Field
              label="Summary"
              hint="Optional. Shown on the archive index and in RSS; default: the template preheader."
              error={errors['archive.summary']}
            >
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

      <FieldGroup legend="Test subject lines">
        <Checkbox
          label="Test subject lines on a sample"
          hint="Send each subject to part of the audience, then the winner to everyone else. The message records its variant for reporting."
          checked={!!test}
          disabled={readOnly || !content.template?.startsWith('eml_')}
          onChange={(e) => set({ subjectTest: e.target.checked ? DEFAULT_TEST : undefined })}
        />
        {!content.template?.startsWith('eml_') && content.template && (
          <p className="text-[12px] text-muted">Subject tests are for e-mail broadcasts only.</p>
        )}
        {test && (
          <div className="space-y-4 rounded-md border border-line p-4">
            <div className="space-y-2">
              {test.subjects.map((subject, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: subject lines are plain strings with no id, and their position is their identity
                <Field key={i} label={`Subject ${String.fromCharCode(65 + i)}`} error={errors[`subjectTest.subjects.${i}`]}>
                  <div className="flex gap-2">
                    <Input
                      value={subject}
                      onChange={(e) => setSubject(i, e.target.value)}
                      readOnly={readOnly}
                      maxLength={300}
                      placeholder={i === 0 ? 'The template subject, or a variant of it' : 'Another subject line'}
                    />
                    {test.subjects.length > 2 && !readOnly && (
                      <Button size="sm" variant="ghost" onClick={() => removeSubject(i)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </Field>
              ))}
              {test.subjects.length < 4 && !readOnly && (
                <Button size="sm" variant="ghost" onClick={addSubject}>
                  Add subject
                </Button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Sample" unit="%" error={errors['subjectTest.samplePercent']} hint="10–50% of the audience.">
                <Input
                  type="number"
                  min={10}
                  max={50}
                  value={test.samplePercent}
                  onChange={(e) => setTest({ samplePercent: Number(e.target.value) })}
                  readOnly={readOnly}
                />
              </Field>
              <Field
                label="Winner by"
                error={errors['subjectTest.metric']}
                hint="Clicks are reliable; opens are not with Apple Mail Privacy Protection."
              >
                <Select
                  value={test.metric}
                  onChange={(e) => setTest({ metric: e.target.value as SubjectTest['metric'] })}
                  disabled={readOnly}
                >
                  <option value="click">Clicks</option>
                  <option value="open">Opens</option>
                </Select>
              </Field>
              <Field label="Decide after" error={errors['subjectTest.decideAfter']} hint="ISO duration, PT1H–P2D, e.g. PT4H.">
                <Input
                  value={test.decideAfter}
                  onChange={(e) => setTest({ decideAfter: e.target.value })}
                  readOnly={readOnly}
                  placeholder="PT4H"
                />
              </Field>
            </div>
          </div>
        )}
      </FieldGroup>

      <Field label="Description" hint="For the team; recipients never see it." error={errors.description}>
        <Textarea
          rows={2}
          value={content.description ?? ''}
          onChange={(e) => set({ description: e.target.value })}
          readOnly={readOnly}
          maxLength={500}
        />
      </Field>
      {content.template && content.segment && (
        <p className="text-[13px] text-muted">
          Sends <RefName id={content.template} /> to <RefName id={content.segment} />.
        </p>
      )}
    </div>
  );
}
