import { useCrumbs } from '../../app/page';
import { useWorkspace } from '../../app/session';
import { setThemePref, type ThemePref, useThemePref } from '../../app/theme';
import { roleLabel } from '../../features/settings/roles';
import { Card, Meta, Mono, PageHeader, RadioCards, Tag } from '../../ui';
import { pageWidth } from '../../ui/layout';

const THEME_OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follows your device setting.' },
  { value: 'light', label: 'Light', hint: 'Always light.' },
  { value: 'dark', label: 'Dark', hint: 'Always dark.' },
];

/** Your preferences: theme on this device, your account, and what your role allows. */
export default function PreferencesPage() {
  useCrumbs([{ label: 'Preferences' }]);
  const { user, workspace } = useWorkspace();
  const theme = useThemePref();
  const explained = workspace.permissionsExplained;

  return (
    <div className={pageWidth('reading')}>
      <PageHeader title="Preferences" description="Your appearance on this device, and what your account and role allow." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Appearance" description="Kept for you on this device." padded>
          <RadioCards name="theme" value={theme} onChange={setThemePref} options={THEME_OPTIONS} />
        </Card>
        <Card title="Account" description="You are signed in to this workspace." padded>
          <Meta
            items={[
              [
                'Signed in as',
                <span>
                  <span className="font-medium text-fg">{user.name || 'No name'}</span> <span className="text-muted">{user.email}</span>
                </span>,
              ],
              ['Workspace', workspace.name],
              ['Role', <Tag>{roleLabel(workspace.you.role)}</Tag>],
            ]}
          />
        </Card>
      </div>

      <Card title="What you can do" description="Your permissions in this workspace, and what each one allows." className="mt-5">
        {explained.length ? (
          <div className="p-4">
            <Meta items={explained.map(({ permission, meaning }) => [<Mono>{permission}</Mono>, meaning])} />
          </div>
        ) : (
          <p className="p-4 text-[13px] text-muted">No permissions are listed for this account.</p>
        )}
      </Card>
    </div>
  );
}
