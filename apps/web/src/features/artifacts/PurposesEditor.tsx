import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { Alert, Button, Checkbox, Field, IconButton, Input, Select, Switch, Textarea } from '../../ui';
import type { EditorProps } from './ArtifactDetailPage';

// The purposes in force: key, the name and description people see, the lawful basis, the channels
// it covers, double opt-in and the LIA record legitimate interest needs. A key that is in use by
// forms, journeys or messages cannot be renamed here; that would silently break them.

type Basis = 'consent' | 'legitimate_interest' | 'contract' | 'legal_obligation';
type Channel = 'email' | 'web' | 'sms' | 'push' | 'webhook';

interface Lia {
  assessment: string;
  owner: string;
  reviewBy: string;
  [key: string]: unknown;
}

export interface Topic {
  key: string;
  name: string;
  description?: string;
  default?: 'subscribed' | 'unsubscribed';
  [key: string]: unknown;
}

export interface Purpose {
  key: string;
  name: string;
  description?: string;
  basis: Basis;
  channels: Channel[];
  requiresDoubleOptIn?: boolean;
  topics?: Topic[];
  lia?: Lia;
  [key: string]: unknown;
}

interface PurposesContent {
  purposes?: Purpose[];
  [key: string]: unknown;
}

const BASIS_LABEL: Record<Basis, string> = {
  consent: 'Consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
};

const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'email', label: 'E-mail' },
  { value: 'web', label: 'Website' },
  { value: 'sms', label: 'SMS' },
  { value: 'push', label: 'Push' },
  { value: 'webhook', label: 'Webhook' },
];

/** Add a valid starter purpose; the key stays editable until it is used in the workspace. */
export function addPurpose(purposes: Purpose[] | undefined): Purpose[] {
  const list = purposes ?? [];
  const keys = new Set(list.map((p) => p.key));
  let n = list.length + 1;
  while (keys.has(`purpose_${n}`)) n++;
  return [
    ...list,
    { key: `purpose_${n}`, name: 'New purpose', description: '', basis: 'consent', channels: [], requiresDoubleOptIn: false },
  ];
}

export function updatePurpose(purposes: Purpose[] | undefined, index: number, patch: Partial<Purpose>): Purpose[] {
  return (purposes ?? []).map((p, i) => (i === index ? { ...p, ...patch } : p));
}

export function removePurpose(purposes: Purpose[] | undefined, index: number): Purpose[] {
  return (purposes ?? []).filter((_, i) => i !== index);
}

/** Switching basis keeps or removes the LIA record the schema asks for. */
export function changeBasis(purpose: Purpose, basis: Basis): Purpose {
  if (basis === 'legitimate_interest') return { ...purpose, basis, lia: purpose.lia ?? { assessment: '', owner: '', reviewBy: '' } };
  const next = { ...purpose, basis };
  delete next.lia;
  return next;
}

/** A purpose key in force is referenced somewhere, so renaming it in the UI would break that. */
export function isKeyLocked(key: string, inUse: Iterable<string>): boolean {
  for (const used of inUse) if (used === key) return true;
  return false;
}

/** Add a topic with a free key, e.g. newsletter_2, valid under the topic key pattern. */
export function addTopic(purpose: Purpose): Purpose {
  const topics = purpose.topics ?? [];
  const keys = new Set(topics.map((t) => t.key));
  let n = topics.length + 1;
  while (keys.has(`topic_${n}`)) n++;
  return {
    ...purpose,
    topics: [...topics, { key: `topic_${n}`, name: `Topic ${n}`, description: '', default: 'subscribed' }],
  };
}

export function updateTopic(purpose: Purpose, index: number, patch: Partial<Topic>): Purpose {
  return { ...purpose, topics: (purpose.topics ?? []).map((t, i) => (i === index ? { ...t, ...patch } : t)) };
}

export function removeTopic(purpose: Purpose, index: number): Purpose {
  return { ...purpose, topics: (purpose.topics ?? []).filter((_, i) => i !== index) };
}

/** The topics of one purpose, for the template and broadcast pickers. */
export function topicsOf(purposes: { key: string; topics?: Topic[] }[], purpose: string | undefined): Topic[] {
  return purposes.find((p) => p.key === purpose)?.topics ?? [];
}

export function PurposesEditor({ content, onChange, readOnly, errors, warnings }: EditorProps<PurposesContent>) {
  const set = (patch: Partial<PurposesContent>) => onChange({ ...content, ...patch });
  const purposes = content.purposes ?? [];
  const inForce = useApi(() => api.call('purposes.list', {}), []);
  const inUse = new Set((inForce.data?.purposes ?? []).map((p) => p.key));
  const keysKnown = !!inForce.data;

  return (
    <div className="max-w-[900px] space-y-6">
      {inForce.error && (
        <Alert tone="bad" title="Couldn't load the purposes in force" onRetry={inForce.reload}>
          Keys stay locked until they load, so a rename cannot break forms or journeys. {inForce.error}
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert tone="warn" title="The schema still needs">
          <ul className="list-disc pl-4">
            {warnings.map((w) => (
              <li key={`${w.path}-${w.message}`}>{w.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <p className="text-[13px] text-fg-2">
        People see the name and description; journeys, forms and messages refer to the key. A key that is already in force cannot be renamed
        here.
      </p>

      {purposes.map((purpose, i) => {
        const n = i + 1;
        const locked = !keysKnown || isKeyLocked(purpose.key, inUse);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: purposes are edited in place and their key column is being typed, so it cannot be the React identity
          <section key={i} className="space-y-3 rounded-lg border border-line p-4" aria-label={`Purpose ${n}`}>
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-medium text-fg">Purpose {n}</h2>
              {locked && keysKnown && (
                <span className="text-[12px] text-muted" title="Forms, journeys or messages refer to this key.">
                  in use
                </span>
              )}
              {!readOnly && (
                <div className="ml-auto">
                  <IconButton
                    label={`Remove purpose ${n}`}
                    icon={<Trash2 size={14} />}
                    size="sm"
                    variant="danger"
                    onClick={() => set({ purposes: removePurpose(purposes, i) })}
                    disabled={purposes.length <= 1}
                    title={purposes.length <= 1 ? 'At least one purpose is needed.' : undefined}
                  />
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <Field
                label={`Key of purpose ${n}`}
                hint={
                  !keysKnown
                    ? 'Loading the purposes in force; the key stays locked until they load.'
                    : locked
                      ? 'In use by forms or journeys, so it cannot be renamed here.'
                      : 'Lowercase letters, digits and _, e.g. marketing_email.'
                }
                error={errors[`purposes.${i}.key`]}
                required
              >
                <Input
                  value={purpose.key}
                  readOnly={readOnly || locked}
                  maxLength={64}
                  spellCheck={false}
                  onChange={(e) => set({ purposes: updatePurpose(purposes, i, { key: e.target.value }) })}
                />
              </Field>
              <Field
                label={`Name of purpose ${n}`}
                hint="Shown to people in consent banners and preferences."
                error={errors[`purposes.${i}.name`]}
                required
              >
                <Input
                  value={purpose.name}
                  readOnly={readOnly}
                  maxLength={120}
                  placeholder="Marketing e-mail"
                  onChange={(e) => set({ purposes: updatePurpose(purposes, i, { name: e.target.value }) })}
                />
              </Field>
            </div>

            <Field
              label={`Description of purpose ${n}`}
              hint="Shown next to the name, in plain words, e.g. what people get and how often."
              error={errors[`purposes.${i}.description`]}
            >
              <Textarea
                rows={2}
                maxLength={1000}
                value={purpose.description ?? ''}
                readOnly={readOnly}
                onChange={(e) => set({ purposes: updatePurpose(purposes, i, { description: e.target.value }) })}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Lawful basis of purpose ${n}`} error={errors[`purposes.${i}.basis`]}>
                <Select
                  value={purpose.basis}
                  disabled={readOnly}
                  onChange={(e) => set({ purposes: updatePurpose(purposes, i, changeBasis(purpose, e.target.value as Basis)) })}
                >
                  {(Object.keys(BASIS_LABEL) as Basis[]).map((b) => (
                    <option key={b} value={b}>
                      {BASIS_LABEL[b]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <Switch
                  checked={purpose.requiresDoubleOptIn ?? false}
                  disabled={readOnly}
                  label={`Double opt-in for purpose ${n}`}
                  onChange={(v) => set({ purposes: updatePurpose(purposes, i, { requiresDoubleOptIn: v }) })}
                />
                <p className="mt-1 text-[12px] text-muted">Consent counts only after the person confirms by e-mail.</p>
              </div>
            </div>

            <fieldset className="min-w-0">
              <legend className="mb-1 text-[12px] font-medium text-fg-2">Channels for purpose {n}</legend>
              <div className="grid gap-1.5 sm:grid-cols-3">
                {CHANNELS.map((c) => (
                  <Checkbox
                    key={c.value}
                    checked={purpose.channels.includes(c.value)}
                    disabled={readOnly}
                    label={c.label}
                    onChange={(e) =>
                      set({
                        purposes: updatePurpose(purposes, i, {
                          channels: e.target.checked ? [...purpose.channels, c.value] : purpose.channels.filter((x) => x !== c.value),
                        }),
                      })
                    }
                  />
                ))}
              </div>
              {errors[`purposes.${i}.channels`] && <p className="mt-1 text-[12px] text-bad">{errors[`purposes.${i}.channels`]}</p>}
            </fieldset>

            <fieldset className="min-w-0 space-y-2">
              <legend className="mb-1 text-[12px] font-medium text-fg-2">Topics under purpose {n}</legend>
              <p className="text-[12px] text-muted">
                Optional finer choices, e.g. newsletter and product news. People can refuse a topic without leaving the purpose; consent for
                the purpose still decides whether anything may be sent.
              </p>
              {(purpose.topics ?? []).map((topic, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: topics are edited in place and their key column is being typed, so it cannot be the React identity
                <div key={j} className="space-y-2 rounded-md border border-line bg-surface-2 p-3">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] sm:items-end">
                    <Field label={`Topic key ${j + 1}`} error={errors[`purposes.${i}.topics.${j}.key`]} required>
                      <Input
                        value={topic.key}
                        readOnly={readOnly}
                        maxLength={41}
                        spellCheck={false}
                        placeholder="newsletter"
                        onChange={(e) => set({ purposes: updatePurpose(purposes, i, updateTopic(purpose, j, { key: e.target.value })) })}
                      />
                    </Field>
                    <Field label={`Topic name ${j + 1}`} error={errors[`purposes.${i}.topics.${j}.name`]} required>
                      <Input
                        value={topic.name}
                        readOnly={readOnly}
                        maxLength={120}
                        placeholder="Weekly newsletter"
                        onChange={(e) => set({ purposes: updatePurpose(purposes, i, updateTopic(purpose, j, { name: e.target.value })) })}
                      />
                    </Field>
                    <Field label={`Default ${j + 1}`} hint="Until the person chooses." error={errors[`purposes.${i}.topics.${j}.default`]}>
                      <Select
                        value={topic.default ?? 'subscribed'}
                        disabled={readOnly}
                        onChange={(e) =>
                          set({
                            purposes: updatePurpose(
                              purposes,
                              i,
                              updateTopic(purpose, j, { default: e.target.value as 'subscribed' | 'unsubscribed' }),
                            ),
                          })
                        }
                      >
                        <option value="subscribed">Subscribed</option>
                        <option value="unsubscribed">Unsubscribed</option>
                      </Select>
                    </Field>
                    {!readOnly && (
                      <IconButton
                        label={`Remove topic ${j + 1} from purpose ${n}`}
                        icon={<Trash2 size={14} />}
                        size="sm"
                        variant="danger"
                        onClick={() => set({ purposes: updatePurpose(purposes, i, removeTopic(purpose, j)) })}
                      />
                    )}
                  </div>
                  <Field label={`Topic description ${j + 1}`} error={errors[`purposes.${i}.topics.${j}.description`]}>
                    <Input
                      value={topic.description ?? ''}
                      readOnly={readOnly}
                      maxLength={500}
                      placeholder="What people get, in plain words"
                      onChange={(e) =>
                        set({ purposes: updatePurpose(purposes, i, updateTopic(purpose, j, { description: e.target.value })) })
                      }
                    />
                  </Field>
                </div>
              ))}
              {!readOnly && (purpose.topics ?? []).length < 20 && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Plus size={13} />}
                  onClick={() => set({ purposes: updatePurpose(purposes, i, addTopic(purpose)) })}
                >
                  Add topic
                </Button>
              )}
              {errors[`purposes.${i}.topics`] && <p className="text-[12px] text-bad">{errors[`purposes.${i}.topics`]}</p>}
            </fieldset>

            {purpose.basis === 'legitimate_interest' && (
              <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
                <p className="text-[12px] font-medium text-fg-2">Legitimate interest assessment (LIA)</p>
                <p className="text-[12px] text-muted">
                  Required for legitimate interest. Record why the interest outweighs the person's rights, who owns it and when it is
                  reviewed.
                </p>
                {!purpose.lia && <p className="text-[12px] text-bad">Add an LIA record: all three fields are required.</p>}
                <Field label={`LIA assessment for purpose ${n}`} error={errors[`purposes.${i}.lia.assessment`]}>
                  <Textarea
                    rows={3}
                    maxLength={5000}
                    value={purpose.lia?.assessment ?? ''}
                    readOnly={readOnly}
                    onChange={(e) =>
                      set({
                        purposes: updatePurpose(purposes, i, {
                          lia: { assessment: e.target.value, owner: purpose.lia?.owner ?? '', reviewBy: purpose.lia?.reviewBy ?? '' },
                        }),
                      })
                    }
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={`LIA owner for purpose ${n}`} error={errors[`purposes.${i}.lia.owner`]}>
                    <Input
                      value={purpose.lia?.owner ?? ''}
                      readOnly={readOnly}
                      maxLength={200}
                      placeholder="Name of the person responsible"
                      onChange={(e) =>
                        set({
                          purposes: updatePurpose(purposes, i, {
                            lia: {
                              assessment: purpose.lia?.assessment ?? '',
                              owner: e.target.value,
                              reviewBy: purpose.lia?.reviewBy ?? '',
                            },
                          }),
                        })
                      }
                    />
                  </Field>
                  <Field
                    label={`LIA review date for purpose ${n}`}
                    hint="The date the assessment is next reviewed."
                    error={errors[`purposes.${i}.lia.reviewBy`]}
                  >
                    <Input
                      type="date"
                      value={purpose.lia?.reviewBy ?? ''}
                      readOnly={readOnly}
                      onChange={(e) =>
                        set({
                          purposes: updatePurpose(purposes, i, {
                            lia: { assessment: purpose.lia?.assessment ?? '', owner: purpose.lia?.owner ?? '', reviewBy: e.target.value },
                          }),
                        })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}
          </section>
        );
      })}

      {!readOnly && purposes.length < 50 && (
        <Button variant="secondary" icon={<Plus size={14} />} onClick={() => set({ purposes: addPurpose(purposes) })}>
          Add purpose
        </Button>
      )}
    </div>
  );
}
