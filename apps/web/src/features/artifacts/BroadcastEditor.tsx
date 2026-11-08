import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../app/session';
import { Alert, Button, Checkbox, DateTimeInput, Field, Input, RadioCards, Select, Textarea } from '../../ui';
import { getWorkspaceTimeZone } from '../../ui/time';
import { ComposerPreview } from '../broadcasts/composer/ComposerPreview';
import {
  type ComposerBroadcastContent,
  previewSourceFor,
  type SendWindow,
  type StagedSend,
  type SubjectTest,
} from '../broadcasts/composer/model';
import { useAudienceEstimate, useComposerData, useSharedArtifact } from '../broadcasts/composer/useComposerData';
import type { EditorProps } from './ArtifactDetailPage';
import { ArtifactSelect } from './ArtifactSelect';
import { topicsOf } from './PurposesEditor';

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type SendMode = 'publication' | 'schedule';

type Broadcast = ComposerBroadcastContent;

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
const DEFAULT_STAGED: StagedSend = {
  canaryPercent: 10,
  wait: 'PT2H',
  maxBounceRate: 0.05,
  maxComplaintRate: 0.003,
  maxUnsubscribeRate: 0.02,
  minCanary: 50,
};

const sectionClass = 'min-w-0 scroll-mt-24 space-y-3';

/**
 * The broadcast Content tab as a single-page composer (#497): What / Who / When beside the live
 * unsaved preview, the eligible-audience estimate and the four pre-send evidence rows. Save and
 * publish stay in the artifact header; this editor never sends, and never writes a temporary
 * artifact to preview something.
 */
export function BroadcastEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<Broadcast>) {
  const { can } = useWorkspace();
  const canRead = can('artifacts:read');
  const canAdmin = can('workspace:admin');
  const broadcast = content ?? {};
  const saved = (artifact.version.content ?? {}) as Broadcast;
  const dirty = JSON.stringify(broadcast) !== JSON.stringify(saved);
  const baseVersion = artifact.version.number;
  const source = previewSourceFor({ dirty, version: baseVersion, publishedVersion: artifact.publishedVersion });

  const [refreshKey, setRefreshKey] = useState(0);
  const data = useComposerData({
    templateId: broadcast.template,
    broadcastTopic: broadcast.topic,
    canRead,
    canAdmin,
    refreshKey,
  });
  // One exact read for the selected segment's name; the preview must reflect the unsaved choice.
  const segment = useSharedArtifact(broadcast.segment);
  // A draft save can replace the saved content in place, keeping the version number (#497).
  const savedRevision = artifact.version.contentHash ?? JSON.stringify(saved);
  const estimate = useAudienceEstimate({
    artifactId: artifact.id,
    version: baseVersion,
    savedRevision,
    dirty,
    template: broadcast.template,
    segment: broadcast.segment,
    enabled: canRead,
  });

  const [sendMode, setSendMode] = useState<SendMode>(broadcast.sendAt ? 'schedule' : 'publication');
  useEffect(() => {
    if (broadcast.sendAt) setSendMode('schedule');
  }, [broadcast.sendAt]);

  const testRef = useRef<HTMLDetailsElement>(null);
  const stagedRef = useRef<HTMLDetailsElement>(null);
  const archiveRef = useRef<HTMLDetailsElement>(null);
  const testOn = !!broadcast.subjectTest;
  const stagedOn = !!broadcast.stagedSend;
  const archiveOn = !!broadcast.archive?.publish;
  const testError = Object.keys(errors).some((key) => key.startsWith('subjectTest.'));
  const stagedError = Object.keys(errors).some((key) => key.startsWith('stagedSend.'));
  const archiveError = Object.keys(errors).some((key) => key.startsWith('archive.'));
  useEffect(() => {
    if ((testOn || testError) && testRef.current) testRef.current.open = true;
  }, [testOn, testError]);
  useEffect(() => {
    if ((stagedOn || stagedError) && stagedRef.current) stagedRef.current.open = true;
  }, [stagedOn, stagedError]);
  useEffect(() => {
    if ((archiveOn || archiveError) && archiveRef.current) archiveRef.current.open = true;
  }, [archiveOn, archiveError]);

  const set = (patch: Partial<Broadcast>) =>
    onChange(
      Object.fromEntries(
        Object.entries({ ...broadcast, ...patch }).filter(([, value]) => value !== undefined && value !== ''),
      ) as Broadcast,
    );
  const purposes = data.purposes.data?.purposes ?? [];
  const templatePurpose = data.templateContent?.purpose;
  const topics = topicsOf(purposes, templatePurpose);
  const purposeLabel = data.purpose
    ? `${data.purpose.name} · ${data.purpose.basis}`
    : templatePurpose
      ? `${templatePurpose} (not configured)`
      : 'Choose a template first';
  const topicName = broadcast.topic ? (topics.find((topic) => topic.key === broadcast.topic)?.name ?? broadcast.topic) : 'No topic';
  const test = broadcast.subjectTest;
  const setTest = (patch: Partial<SubjectTest>) => set({ subjectTest: { ...(test ?? DEFAULT_TEST), ...patch } });
  const staged = broadcast.stagedSend;
  const setStaged = (patch: Partial<StagedSend>) => set({ stagedSend: { ...(staged ?? DEFAULT_STAGED), ...patch } });
  const window = broadcast.sendWindow;
  const setWindow = (patch: Partial<SendWindow>) => set({ sendWindow: { ...(window ?? DEFAULT_WINDOW), ...patch } });
  const toggleDay = (day: Weekday) => {
    const days = window?.days ?? [];
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    // No days means every day; all seven is the same thing, so keep the stored value simple.
    setWindow({ days: next.length === 0 || next.length === 7 ? undefined : next });
  };
  const setSubject = (i: number, value: string) =>
    setTest({ subjects: (test?.subjects ?? []).map((subject, j) => (j === i ? value : subject)) });
  const addSubject = () => setTest({ subjects: [...(test?.subjects ?? []), ''] });
  const removeSubject = (i: number) => setTest({ subjects: (test?.subjects ?? []).filter((_, j) => j !== i) });
  const isEmail = !!broadcast.template?.startsWith('eml_');
  const zone = getWorkspaceTimeZone();
  const chooseSendMode = (mode: SendMode) => {
    setSendMode(mode);
    if (mode === 'publication') set({ sendAt: undefined });
  };

  return (
    <div className="min-w-0 space-y-5">
      {readOnly && <Alert tone="info">Your role can read this broadcast but cannot edit it.</Alert>}
      <nav aria-label="Composer sections" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[18px]">
        <a href="#composer-what" className="font-medium text-accent hover:underline">
          1 What
        </a>
        <span aria-hidden className="text-muted">
          ·
        </span>
        <a href="#composer-who" className="font-medium text-accent hover:underline">
          2 Who
        </a>
        <span aria-hidden className="text-muted">
          ·
        </span>
        <a href="#composer-when" className="font-medium text-accent hover:underline">
          3 When
        </a>
        <span aria-hidden className="text-muted">
          ·
        </span>
        <a href="#composer-preview" className="font-medium text-accent hover:underline">
          Jump to preview
        </a>
      </nav>

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-6 border-0 p-0">
          <legend className="sr-only">Broadcast settings</legend>

          <section id="composer-what" aria-labelledby="composer-what-title" className={sectionClass}>
            <h2 id="composer-what-title" className="text-[16px] leading-6 font-semibold">
              1 · What
            </h2>
            <Field
              label="Template"
              error={errors.template}
              hint="Use one template per issue. It must be live before the broadcast can be published."
              required
            >
              <ArtifactSelect
                type="email_template"
                value={broadcast.template}
                onChange={(value) => set({ template: value, topic: undefined })}
                disabled={readOnly}
              />
            </Field>
            <div>
              <p className="mb-1 text-[12px] leading-[18px] font-medium text-fg-2">Purpose</p>
              <p className="min-h-5 text-[13px] leading-5 break-words text-fg-2">{purposeLabel}</p>
              <p className="mt-1 text-[12px] leading-[18px] text-muted">
                From the selected template. Choose the purpose on the template itself.
              </p>
            </div>
            <Field
              label="Topic (optional)"
              error={errors.topic}
              hint={
                templatePurpose
                  ? 'A finer choice under the template’s purpose; it overrides the template’s own topic.'
                  : 'Choose a template first.'
              }
            >
              <Select
                value={broadcast.topic ?? ''}
                disabled={readOnly || topics.length === 0}
                onChange={(e) => set({ topic: e.target.value || undefined })}
              >
                <option value="">{topics.length ? 'No topic' : 'No topics'}</option>
                {broadcast.topic && !topics.some((t) => t.key === broadcast.topic) && (
                  <option value={broadcast.topic}>Unavailable topic · not under this purpose</option>
                )}
                {topics.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description (team only)" hint="Recipients never see it." error={errors.description}>
              <Textarea
                rows={2}
                value={broadcast.description ?? ''}
                onChange={(e) => set({ description: e.target.value })}
                readOnly={readOnly}
                maxLength={500}
              />
            </Field>
          </section>

          <section id="composer-who" aria-labelledby="composer-who-title" className={sectionClass}>
            <h2 id="composer-who-title" className="text-[16px] leading-6 font-semibold">
              2 · Who
            </h2>
            <Field
              label="Segment"
              error={errors.segment}
              hint="Membership is not consent. Eligibility is checked again at send time."
              required
            >
              <ArtifactSelect type="segment" value={broadcast.segment} onChange={(value) => set({ segment: value })} disabled={readOnly} />
            </Field>
            <p className="text-[12px] leading-[18px] text-muted">
              Everyone in the segment who allows the template’s purpose gets it; others are skipped and counted in the next check.
            </p>
          </section>

          <section id="composer-when" aria-labelledby="composer-when-title" className={sectionClass}>
            <h2 id="composer-when-title" className="text-[16px] leading-6 font-semibold">
              3 · When
            </h2>
            <RadioCards<SendMode>
              name="broadcast-send-mode"
              value={sendMode}
              onChange={chooseSendMode}
              className="sm:grid-cols-1"
              options={[
                { value: 'publication', label: 'On publication', hint: 'Sends as soon as it is published.' },
                { value: 'schedule', label: 'Schedule', hint: 'Sends at a chosen time in the workspace zone.' },
              ]}
            />
            {sendMode === 'schedule' && (
              <Field label="Send at" error={errors.sendAt} hint={`In ${zone} (Settings → Workspace).`}>
                <DateTimeInput
                  value={broadcast.sendAt ?? null}
                  onChange={(value) => set({ sendAt: value ?? undefined })}
                  disabled={readOnly}
                />
              </Field>
            )}
            {sendMode === 'schedule' && !broadcast.sendAt && (
              <Alert tone="warn">Choose a send time. Until then the broadcast stays on publication.</Alert>
            )}
            {broadcast.sendAt && new Date(broadcast.sendAt).getTime() < Date.now() && (
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
                <Field label="Days" hint="In the reader’s time zone. None selected means every day.">
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
                <p className="text-[12px] leading-[18px] text-muted">Readers without a valid zone use the delivery-policy zone.</p>
              </div>
            )}
            {!window && <p className="text-[12px] leading-[18px] text-muted">Scheduled time shown in {zone}; arrival time varies.</p>}
          </section>

          <details ref={testRef} className="rounded-lg border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[13px] leading-5 font-medium text-fg">Subject test · {testOn ? 'On' : 'Off'}</summary>
            <div className="mt-4 space-y-4">
              <Checkbox
                label="Test subject lines on a sample"
                hint="Send each subject to part of the audience, then the winner to everyone else. The message records its variant for reporting."
                checked={testOn}
                disabled={readOnly || !isEmail || stagedOn}
                onChange={(e) => set({ subjectTest: e.target.checked ? DEFAULT_TEST : undefined })}
              />
              {stagedOn && !testOn && (
                <p className="text-[12px] leading-[18px] text-muted">Not available with a staged send: sample the audience one way.</p>
              )}
              {testOn && <p className="text-[12px] leading-[18px] text-muted">Staged send is unavailable while a subject test is on.</p>}
              {!isEmail && broadcast.template && (
                <p className="text-[12px] leading-[18px] text-muted">Subject tests are for e-mail broadcasts only.</p>
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
                            <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => removeSubject(i)}>
                              Remove
                            </Button>
                          )}
                        </div>
                      </Field>
                    ))}
                    {test.subjects.length < 4 && !readOnly && (
                      <Button size="sm" variant="ghost" disabled={readOnly} onClick={addSubject}>
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
            </div>
          </details>

          <details ref={stagedRef} className="rounded-lg border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[13px] leading-5 font-medium text-fg">Staged send · {stagedOn ? 'On' : 'Off'}</summary>
            <div className="mt-4 space-y-4">
              <Checkbox
                label="Send a canary share first"
                hint="The canary is a deterministic share of the audience. Its bounce, complaint and unsubscribe rates decide whether the rest goes out."
                checked={stagedOn}
                disabled={readOnly || testOn}
                onChange={(e) => set({ stagedSend: e.target.checked ? DEFAULT_STAGED : undefined })}
              />
              {testOn && !stagedOn && (
                <p className="text-[12px] leading-[18px] text-muted">Not available with a subject test: sample the audience one way.</p>
              )}
              {stagedOn && <p className="text-[12px] leading-[18px] text-muted">Subject test is unavailable while a staged send is on.</p>}
              {testOn && stagedOn && <Alert tone="warn">Choose either a subject test or a staged send, not both.</Alert>}
              {staged && (
                <div className="space-y-4 rounded-md border border-line p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Canary share" unit="%" error={errors['stagedSend.canaryPercent']} hint="5–50% of the audience.">
                      <Input
                        type="number"
                        min={5}
                        max={50}
                        value={staged.canaryPercent}
                        onChange={(e) => setStaged({ canaryPercent: Number(e.target.value) })}
                        readOnly={readOnly}
                      />
                    </Field>
                    <Field label="Wait" error={errors['stagedSend.wait']} hint="ISO duration, PT30M–PT24H, e.g. PT2H.">
                      <Input
                        value={staged.wait}
                        onChange={(e) => setStaged({ wait: e.target.value })}
                        readOnly={readOnly}
                        placeholder="PT2H"
                      />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Max bounce" unit="%" error={errors['stagedSend.maxBounceRate']} hint="Stop above this share.">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={Math.round(staged.maxBounceRate * 10_000) / 100}
                        onChange={(e) => setStaged({ maxBounceRate: Number(e.target.value) / 100 })}
                        readOnly={readOnly}
                      />
                    </Field>
                    <Field label="Max complaints" unit="%" error={errors['stagedSend.maxComplaintRate']} hint="Stop above this share.">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        value={Math.round(staged.maxComplaintRate * 10_000) / 100}
                        onChange={(e) => setStaged({ maxComplaintRate: Number(e.target.value) / 100 })}
                        readOnly={readOnly}
                      />
                    </Field>
                    <Field label="Max unsubscribes" unit="%" error={errors['stagedSend.maxUnsubscribeRate']} hint="Stop above this share.">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={Math.round(staged.maxUnsubscribeRate * 10_000) / 100}
                        onChange={(e) => setStaged({ maxUnsubscribeRate: Number(e.target.value) / 100 })}
                        readOnly={readOnly}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Smallest canary to judge"
                    error={errors['stagedSend.minCanary']}
                    hint="Below this many canary sends the rates are too small to judge and the rest goes out without a check."
                  >
                    <Input
                      type="number"
                      min={1}
                      value={staged.minCanary}
                      onChange={(e) => setStaged({ minCanary: Number(e.target.value) })}
                      readOnly={readOnly}
                    />
                  </Field>
                </div>
              )}
            </div>
          </details>

          <details ref={archiveRef} className="rounded-lg border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[13px] leading-5 font-medium text-fg">
              Newsletter archive · {archiveOn ? 'On' : 'Off'}
            </summary>
            <div className="mt-4 space-y-4">
              <Checkbox
                label="Publish to the archive"
                hint="Only sent issues appear. The page uses the template version that was sent, with empty personalisation."
                checked={archiveOn}
                disabled={readOnly}
                onChange={(e) => set({ archive: { ...(broadcast.archive ?? {}), publish: e.target.checked } })}
              />
              {broadcast.archive?.publish && (
                <>
                  <Field
                    label="Issue address"
                    hint="Optional. Default: the subject plus the send date; lowercase letters, digits and hyphens."
                    error={errors['archive.slug']}
                  >
                    <Input
                      value={broadcast.archive.slug ?? ''}
                      readOnly={readOnly}
                      maxLength={41}
                      placeholder="signal-43"
                      onChange={(e) => set({ archive: { ...(broadcast.archive ?? {}), slug: e.target.value.toLowerCase() } })}
                    />
                  </Field>
                  <Field
                    label="Summary"
                    hint="Optional. Shown on the archive index and in RSS; default: the template preheader."
                    error={errors['archive.summary']}
                  >
                    <Textarea
                      rows={2}
                      value={broadcast.archive.summary ?? ''}
                      readOnly={readOnly}
                      maxLength={500}
                      onChange={(e) => set({ archive: { ...(broadcast.archive ?? {}), summary: e.target.value } })}
                    />
                  </Field>
                </>
              )}
            </div>
          </details>
        </fieldset>

        <div id="composer-preview" className="min-w-0 scroll-mt-24">
          <ComposerPreview
            content={broadcast}
            dirty={dirty}
            source={source}
            estimate={estimate}
            data={data}
            savedRevision={savedRevision}
            segmentName={segment.artifact?.name ?? null}
            topicName={topicName}
            onRefreshChecks={() => setRefreshKey((key) => key + 1)}
          />
        </div>
      </div>
    </div>
  );
}
