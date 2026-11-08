import { useState } from 'react';
import { api, errText } from '../../app/api';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { Alert, Button, Drawer, Field, Input } from '../../ui';

// Short "New brand" wizard (#190): a brand is a workspace, so this one call creates the workspace,
// the owner membership, a draft brand artifact and a pending domain. The person lands in the new
// brand; nothing is copied from the brand they came from.

export function NewBrandDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { switchWorkspace } = useSession();
  const [name, setName] = useState('');
  const [siteName, setSiteName] = useState('');
  const [domain, setDomain] = useState('');
  const [prefix, setPrefix] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName('');
    setSiteName('');
    setDomain('');
    setPrefix('');
    setLogoUrl('');
    setErr('');
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title="New brand"
      meta="A brand has its own content, audience and links. Your account, plan and sign-in are shared."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="new-brand" variant="primary" mutation loading={busy}>
            Create brand
          </Button>
        </>
      }
    >
      <form
        id="new-brand"
        className="space-y-4 py-1"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            const created = await api.call('workspace.create', {
              name: name.trim(),
              ...(domain.trim() ? { primaryDomain: domain.trim() } : {}),
              ...(prefix.trim() ? { pathPrefix: prefix.trim() } : {}),
              ...(siteName.trim() ? { siteName: siteName.trim() } : {}),
              ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}),
            });
            reset();
            onClose();
            navigate('/');
            await switchWorkspace(created.workspaceId);
          } catch (error) {
            setErr(errText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Brand name" required hint="Shown in the switcher and on hosted pages.">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus data-autofocus />
        </Field>
        <Field label="Primary domain" hint="Optional, e.g. links.example.com. It starts pending; verify it before it serves links.">
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="links.example.com" inputMode="url" />
        </Field>
        <Field label="Path prefix" hint="Optional, for a site that proxies /am to this installation.">
          <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="/am" />
        </Field>
        <Field label="Site name" hint="Optional; the hosted-page name. Defaults to the brand name.">
          <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} />
        </Field>
        <Field label="Logo URL" hint="Optional https URL. You can change it later under Design → Brand.">
          <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://example.com/logo.svg" inputMode="url" />
        </Field>
        {err && <Alert tone="bad">{err}</Alert>}
      </form>
    </Drawer>
  );
}
