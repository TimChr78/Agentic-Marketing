import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useWorkspace } from '../../app/session';
import { usePageTab } from '../../app/useTab';
import { SettingsPanelSkeleton } from '../../features/phase28/settings-insights/SettingsPanelSkeleton';
import { Alert, Button, Field, Input, Select, Textarea, useToast } from '../../ui';
import { DetailPage } from '../../ui/DetailPage';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** UTC first, then every zone the browser knows; `Intl` lists them sorted. */
const TIME_ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];

/** Addresses from a textarea, one per line, deduplicated and lowercased. */
function parseSeedList(text: string): { emails: string[]; problem: string | null } {
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > 320) return { emails: [], problem: 'Each address must be 320 characters or fewer.' };
    if (!EMAIL.test(line)) return { emails: [], problem: `“${line}” is not an e-mail address. Use one address per line.` };
    const lower = line.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      emails.push(lower);
    }
  }
  if (emails.length > 50) return { emails: [], problem: `Use at most 50 addresses. There are ${emails.length}.` };
  return { emails, problem: null };
}

const TABS = ['general', 'test-sends'] as const;

/**
 * Workspace (#527): the name and time zone everyone sees, and the addresses that may receive test
 * sends. The two sections save independently, so a failed test-send save never discards a typed name.
 */
export default function WorkspacePage() {
  useCrumbs([{ label: 'Workspace' }]);
  const { workspace, refresh } = useWorkspace();
  const toast = useToast();
  const { active, select } = usePageTab({ keys: TABS, fallback: 'general' });
  const [name, setName] = useState(workspace.name);
  const [timeZone, setTimeZone] = useState(workspace.timeZone);
  const [seedText, setSeedText] = useState(workspace.seedList.join('\n'));
  // A field the person is editing keeps its value through a session refresh; the rest take the
  // new server value (#1277 review).
  const [nameDirty, setNameDirty] = useState(false);
  const [timeZoneDirty, setTimeZoneDirty] = useState(false);
  const [seedDirty, setSeedDirty] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [seedSaveError, setSeedSaveError] = useState<string | null>(null);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingSeed, setSavingSeed] = useState(false);

  // A refresh reads the same values into new objects (the seed list is a new array every time),
  // so only a genuinely different server value may overwrite a field.
  const serverSeed = workspace.seedList.join('\n');
  const seenName = useRef(workspace.name);
  const seenTimeZone = useRef(workspace.timeZone);
  const seenSeed = useRef(serverSeed);
  useEffect(() => {
    if (workspace.name === seenName.current) return;
    seenName.current = workspace.name;
    if (!nameDirty) setName(workspace.name);
  }, [workspace.name, nameDirty]);
  useEffect(() => {
    if (workspace.timeZone === seenTimeZone.current) return;
    seenTimeZone.current = workspace.timeZone;
    if (!timeZoneDirty) setTimeZone(workspace.timeZone);
  }, [workspace.timeZone, timeZoneDirty]);
  useEffect(() => {
    if (serverSeed === seenSeed.current) return;
    seenSeed.current = serverSeed;
    if (!seedDirty) setSeedText(serverSeed);
  }, [serverSeed, seedDirty]);

  const zones = useMemo(
    () => (TIME_ZONES.includes(workspace.timeZone) ? TIME_ZONES : [workspace.timeZone, ...TIME_ZONES]),
    [workspace.timeZone],
  );

  const nameProblem = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return 'Give the workspace a name.';
    if (trimmed.length > 120) return 'Keep the name to 120 characters or fewer.';
    return null;
  };

  const saveGeneral = async () => {
    const nextName = name.trim();
    // Submit only what changed, so an untouched field never overwrites a newer server value.
    const changes: { name?: string; timeZone?: string } = {};
    if (nextName !== workspace.name) changes.name = nextName;
    if (timeZone !== workspace.timeZone) changes.timeZone = timeZone;
    if (changes.name === undefined && changes.timeZone === undefined) return;
    if (changes.name !== undefined) {
      const problem = nameProblem(nextName);
      if (problem) {
        setNameError(problem);
        return;
      }
    }
    setSavingGeneral(true);
    setGeneralError(null);
    try {
      await api.call('workspace.update', changes);
      setNameDirty(false);
      setTimeZoneDirty(false);
      await refresh();
      toast.success('Saved the workspace name and time zone.');
    } catch (e) {
      setGeneralError(errText(e));
    } finally {
      setSavingGeneral(false);
    }
  };

  const saveSeedList = async () => {
    const parsed = parseSeedList(seedText);
    if (parsed.problem) {
      setSeedError(parsed.problem);
      return;
    }
    setSavingSeed(true);
    setSeedSaveError(null);
    try {
      await api.call('workspace.setSeedList', { seedList: parsed.emails });
      setSeedDirty(false);
      await refresh();
      toast.success(
        parsed.emails.length
          ? `Saved ${parsed.emails.length} test-send ${parsed.emails.length === 1 ? 'address' : 'addresses'}.`
          : 'Cleared the test-send list.',
      );
    } catch (e) {
      setSeedSaveError(errText(e));
    } finally {
      setSavingSeed(false);
    }
  };

  return (
    <DetailPage
      title="Workspace"
      kind="Settings"
      metadata={<span>Agentic Marketing {workspace.serverVersion}</span>}
      state="ready"
      loadingContent={<SettingsPanelSkeleton label="Opening workspace settings" />}
      activeTab={active}
      onTabChange={(key) => select(key as (typeof TABS)[number])}
      tabs={[
        {
          key: 'general',
          label: 'General',
          panel: (
            <form
              id="workspace-general-form"
              className="max-w-[560px] space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void saveGeneral();
              }}
            >
              <Field label="Name" error={nameError} required>
                <Input
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameDirty(true);
                    setNameError(null);
                  }}
                  onBlur={(e) => setNameError(nameProblem(e.target.value))}
                />
              </Field>
              <Field label="Time zone" hint="Dates and the send-time picker use this zone.">
                <Select
                  value={timeZone}
                  onChange={(e) => {
                    setTimeZone(e.target.value);
                    setTimeZoneDirty(true);
                  }}
                >
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </Select>
              </Field>
              {generalError && (
                <Alert tone="bad" title="Couldn’t save the workspace details">
                  {generalError}
                </Alert>
              )}
            </form>
          ),
        },
        {
          key: 'test-sends',
          label: 'Test sends',
          panel: (
            <form
              id="workspace-seed-form"
              className="max-w-[560px] space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void saveSeedList();
              }}
            >
              <Field
                label="Seed list"
                hint="One e-mail address per line, at most 50. Test sends go to these addresses as well as workspace members; real broadcasts are not affected."
                error={seedError}
              >
                <Textarea
                  rows={5}
                  mono
                  value={seedText}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    setSeedText(e.target.value);
                    setSeedDirty(true);
                    setSeedError(null);
                  }}
                  onBlur={(e) => {
                    const parsed = parseSeedList(e.target.value);
                    setSeedError(parsed.problem);
                  }}
                />
              </Field>
              {seedSaveError && (
                <Alert tone="bad" title="Couldn’t save the test-send addresses">
                  {seedSaveError}
                </Alert>
              )}
            </form>
          ),
        },
      ]}
      primaryAction={
        active === 'test-sends' ? (
          <Button type="submit" form="workspace-seed-form" variant="primary" mutation loading={savingSeed}>
            Save test sends
          </Button>
        ) : (
          <Button type="submit" form="workspace-general-form" variant="primary" mutation loading={savingGeneral}>
            Save
          </Button>
        )
      }
      consequence={
        <p className="rounded-lg bg-surface-2 px-4 py-3 text-[13px] leading-5 text-fg-2">
          {active === 'test-sends'
            ? 'Test sends reach these addresses as well as workspace members. Real broadcasts are not affected.'
            : 'The name appears throughout the admin UI and in messages where the workspace is named. The time zone sets the dates and send-time picker everyone sees.'}
        </p>
      }
    />
  );
}
