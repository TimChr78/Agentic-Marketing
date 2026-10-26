import { useEffect, useMemo, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useWorkspace } from '../../app/session';
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea, useToast } from '../../ui';

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

/** Workspace settings: name, time zone and the test-send seed list (workspace:admin). */
export default function WorkspacePage() {
  useCrumbs([{ label: 'Workspace' }]);
  const { workspace, refresh } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [timeZone, setTimeZone] = useState(workspace.timeZone);
  const [seedText, setSeedText] = useState(workspace.seedList.join('\n'));
  const [nameError, setNameError] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [seedSaveError, setSeedSaveError] = useState<string | null>(null);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingSeed, setSavingSeed] = useState(false);

  useEffect(() => {
    setName(workspace.name);
    setTimeZone(workspace.timeZone);
  }, [workspace.name, workspace.timeZone]);
  useEffect(() => {
    setSeedText(workspace.seedList.join('\n'));
  }, [workspace.seedList]);

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
    const problem = nameProblem(name);
    if (problem) {
      setNameError(problem);
      return;
    }
    setSavingGeneral(true);
    setGeneralError(null);
    try {
      await api.call('workspace.update', { name: name.trim(), timeZone });
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
    <div>
      <PageHeader
        title="Workspace"
        description="The name and time zone everyone sees, and the addresses that may receive test sends."
      />
      <div className="space-y-5">
        <Card title="General" description="Shown throughout the admin UI and in messages where the workspace is named.">
          <form
            className="space-y-4 p-4"
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
                  setNameError(null);
                }}
                onBlur={(e) => setNameError(nameProblem(e.target.value))}
              />
            </Field>
            <Field label="Time zone" hint="Dates and the send-time picker use this zone.">
              <Select value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
            {generalError && (
              <Alert tone="bad" title="Not saved">
                {generalError}
              </Alert>
            )}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={savingGeneral}>
                Save
              </Button>
            </div>
          </form>
        </Card>

        <Card
          title="Test sends"
          description="Addresses outside the workspace that test sends may go to, such as a monitoring inbox."
        >
          <form
            className="space-y-4 p-4"
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
                  setSeedError(null);
                }}
                onBlur={(e) => {
                  const parsed = parseSeedList(e.target.value);
                  setSeedError(parsed.problem);
                }}
              />
            </Field>
            {seedSaveError && (
              <Alert tone="bad" title="Not saved">
                {seedSaveError}
              </Alert>
            )}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={savingSeed}>
                Save test sends
              </Button>
            </div>
          </form>
        </Card>

        <p className="pt-1 text-center text-[12px] text-muted">Agentic Marketing {workspace.serverVersion}</p>
      </div>
    </div>
  );
}
