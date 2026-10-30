import { useEffect, useState } from 'react';
import { errText } from '../../app/api';
import { Alert, Button, Card, Checkbox, Field, FieldGroup, Input, Meta, RadioCards, Select, Table, Td, THead, Th, Tr } from '../../ui';
import type { AutonomyPatch } from './AutonomyProvider';
import { ACTION_CLASS_LABEL, AUTONOMY_LEVEL, type Autonomy, CEILING_CLASSES, levelFor, levelLabel, SWITCH_INFO } from './labels';

interface Draft {
  switch: Autonomy['switch'];
  audienceThreshold: string;
  changesPerDay: string;
  messagesPerDay: string;
  allowLoops: boolean;
  maxLevel: Record<string, number>;
}

const fromSettings = (s: Autonomy): Draft => ({
  switch: s.switch,
  audienceThreshold: String(s.audienceThreshold),
  changesPerDay: String(s.limits.changesPerDay),
  messagesPerDay: String(s.limits.messagesPerDay),
  allowLoops: s.allowLoops,
  maxLevel: Object.fromEntries(CEILING_CLASSES.map((c) => [c, levelFor(s.maxLevel, c)])),
});

/** A whole number, 0 or more; null when the field is empty or not one. */
const toCount = (value: string): number | null => {
  const n = Number(value);
  return value.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * The workspace autonomy ceilings (#215). The switch, audience threshold and daily limits apply
 * to every agent now; the per-class levels are the ceilings a mandate may grant (#218).
 */
export function AutonomyCard({
  settings,
  canEdit,
  onSave,
}: {
  settings: Autonomy;
  canEdit: boolean;
  onSave: (patch: AutonomyPatch) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Draft>(() => fromSettings(settings));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A save replaces the settings prop; start from the server's answer, not the stale draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the saved settings change
  useEffect(() => setDraft(fromSettings(settings)), [settings]);

  const threshold = toCount(draft.audienceThreshold);
  const changes = toCount(draft.changesPerDay);
  const messages = toCount(draft.messagesPerDay);
  const problems = {
    audienceThreshold: threshold === null ? 'Enter a whole number of people, 0 or more.' : null,
    changesPerDay: changes === null ? 'Enter a whole number, 0 or more.' : null,
    messagesPerDay: messages === null ? 'Enter a whole number, 0 or more.' : null,
  };

  const patch: AutonomyPatch = {};
  if (draft.switch !== settings.switch) patch.switch = draft.switch;
  if (threshold !== null && threshold !== settings.audienceThreshold) patch.audienceThreshold = threshold;
  if (changes !== null && changes !== settings.limits.changesPerDay) patch.limits = { ...patch.limits, changesPerDay: changes };
  if (messages !== null && messages !== settings.limits.messagesPerDay) patch.limits = { ...patch.limits, messagesPerDay: messages };
  if (draft.allowLoops !== settings.allowLoops) patch.allowLoops = draft.allowLoops;
  const changedLevels = CEILING_CLASSES.filter((c) => draft.maxLevel[c] !== levelFor(settings.maxLevel, c));
  if (changedLevels.length) {
    patch.maxLevel = Object.fromEntries(changedLevels.map((c) => [c, draft.maxLevel[c]])) as AutonomyPatch['maxLevel'];
  }
  const dirty = Object.keys(patch).length > 0;
  const invalid = Object.values(problems).some(Boolean);

  const save = async () => {
    if (!dirty || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!canEdit) {
    return (
      <Card title="Autonomy" description="How much an agent may do on its own. Only owners and admins can change these." padded>
        <Meta
          items={[
            ['Agents', SWITCH_INFO[settings.switch].label],
            ['Audience threshold', `${settings.audienceThreshold.toLocaleString('en-US')} people`],
            [
              'Daily limits',
              `${settings.limits.changesPerDay.toLocaleString('en-US')} changes · ${settings.limits.messagesPerDay.toLocaleString('en-US')} messages`,
            ],
            ['Run the loop', settings.allowLoops ? 'Allowed at level 4' : 'Not allowed'],
          ]}
        />
        <div className="mt-4 space-y-1">
          <p className="text-[12px] font-medium text-fg-2">Highest level per action class</p>
          <ul className="grid gap-x-6 gap-y-0.5 text-[12px] text-fg-2 sm:grid-cols-2">
            {CEILING_CLASSES.map((c) => (
              <li key={c} className="flex justify-between gap-2">
                <span className="text-muted">{ACTION_CLASS_LABEL[c]}</span>
                <span>{levelLabel(levelFor(settings.maxLevel, c))}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-4 text-[12px] text-muted">{DEFAULT_SENTENCE}</p>
      </Card>
    );
  }

  return (
    <Card title="Autonomy" description="How much an agent may do on its own. Changes apply to the next agent request.">
      <div className="space-y-5 p-4">
        <FieldGroup legend="Agents may">
          <RadioCards
            name="autonomy-switch"
            value={draft.switch}
            onChange={(v) => setDraft((d) => ({ ...d, switch: v }))}
            options={(Object.keys(SWITCH_INFO) as Autonomy['switch'][]).map((value) => ({
              value,
              label: SWITCH_INFO[value].label,
              hint: SWITCH_INFO[value].description,
            }))}
          />
        </FieldGroup>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Audience threshold"
            hint="An action reaching more people than this needs a person."
            unit="people"
            error={problems.audienceThreshold}
          >
            <Input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={draft.audienceThreshold}
              onChange={(e) => setDraft((d) => ({ ...d, audienceThreshold: e.target.value }))}
            />
          </Field>
          <Field label="Changes per day" hint="Per agent, beyond drafts." error={problems.changesPerDay}>
            <Input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={draft.changesPerDay}
              onChange={(e) => setDraft((d) => ({ ...d, changesPerDay: e.target.value }))}
            />
          </Field>
          <Field label="Messages per day" hint="Messages an agent may send itself." error={problems.messagesPerDay}>
            <Input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={draft.messagesPerDay}
              onChange={(e) => setDraft((d) => ({ ...d, messagesPerDay: e.target.value }))}
            />
          </Field>
        </div>

        <Checkbox
          label="Allow level 4 (run the loop)"
          hint="A mandate may let an agent start new work of a class on its own. Off, no mandate can grant level 4."
          checked={draft.allowLoops}
          onChange={(e) => setDraft((d) => ({ ...d, allowLoops: e.target.checked }))}
        />

        <div>
          <p className="text-[12px] font-medium text-fg-2">Highest level per action class</p>
          <p className="mt-0.5 text-[12px] text-muted">A mandate may grant a class up to this level. Missing classes are level 1.</p>
          <div className="mt-2 overflow-x-auto rounded-md border border-line">
            <Table label="Highest autonomy level per action class" className="text-[12px]">
              <THead>
                <tr>
                  <Th>Action class</Th>
                  <Th align="right">Highest level</Th>
                </tr>
              </THead>
              <tbody>
                {CEILING_CLASSES.map((c) => (
                  <Tr key={c}>
                    <Td className="py-1.5 whitespace-nowrap">{ACTION_CLASS_LABEL[c]}</Td>
                    <Td align="right" className="py-1.5">
                      <Select
                        compact
                        className="w-auto"
                        aria-label={`Highest level for ${ACTION_CLASS_LABEL[c]}`}
                        value={String(draft.maxLevel[c])}
                        onChange={(e) => setDraft((d) => ({ ...d, maxLevel: { ...d.maxLevel, [c]: Number(e.target.value) } }))}
                      >
                        {AUTONOMY_LEVEL.map((label, level) => (
                          <option key={label} value={level}>
                            {level} · {label}
                          </option>
                        ))}
                      </Select>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        </div>

        <p className="text-[12px] text-muted">{DEFAULT_SENTENCE}</p>
        {error && (
          <Alert tone="bad" title="Not saved">
            {error}
          </Alert>
        )}
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} disabled={!dirty || invalid} onClick={() => void save()}>
            Save autonomy
          </Button>
        </div>
      </div>
    </Card>
  );
}

const DEFAULT_SENTENCE =
  'The default is a person (level 1); levels apply to mandates (a later release) while the switch, threshold and limits apply now to every agent.';
