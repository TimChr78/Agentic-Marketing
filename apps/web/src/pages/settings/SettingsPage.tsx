import { useEffect } from 'react';
import { settingsPath } from '../../app/nav';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { SettingsPanelSkeleton } from '../../features/phase28/settings-insights/SettingsPanelSkeleton';

/** `/settings` replaces to the first permitted secondary item; Integrations is the fallback. */
export default function SettingsPage() {
  const { can } = useSession();
  useEffect(() => {
    navigate(settingsPath(can), { replace: true });
  }, [can]);
  return <SettingsPanelSkeleton label="Opening Settings" />;
}
