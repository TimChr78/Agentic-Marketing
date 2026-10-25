import { Send } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { useSession } from '../../app/session';
import { ArtifactDetailPage } from '../../features/artifacts/ArtifactDetailPage';
import { TemplateEditor } from '../../features/templates/TemplateEditor';
import { Button, useToast } from '../../ui';

export default function TemplatePage({ params }: { params: Record<string, string> }) {
  return (
    <ArtifactDetailPage
      id={params.id}
      crumbs={[{ label: 'E-mail templates', to: '/design/templates' }]}
      editor={(p) => <TemplateEditor {...p} />}
      extraActions={(a) => <SendTest id={a.id} version={a.version.number} />}
    />
  );
}

function SendTest({ id, version }: { id: string; version: number }) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can('artifacts:write')) return null;
  return (
    <Button
      icon={<Send size={14} />}
      loading={busy}
      title="Send a [Test] copy of the saved version to your own address"
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api.call('templates.sendTest', { artifactId: id, version });
          toast.success(`Test of v${version} sent to ${r.to}.`);
        } catch (e) {
          toast.error(`The test was not sent: ${errText(e)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      Send me a test
    </Button>
  );
}
