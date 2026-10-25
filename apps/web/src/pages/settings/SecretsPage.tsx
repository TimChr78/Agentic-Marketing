import { Plus, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useApi } from '../../app/useApi';
import { useWorkspace } from '../../app/session';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  Field,
  fieldErrors,
  formatDateTime,
  Input,
  Mono,
  PageHeader,
  Table,
  TableFrame,
  Td,
  Th,
  THead,
  timeAgo,
  Tr,
  useConfirm,
  useToast,
} from '../../ui';

type Secret = Out<'secrets.list'>['secrets'][number];
type Editing = { mode: 'add' } | { mode: 'rotate'; secret: Secret };

// The server never returns a secret's value (secrets.list has names and metadata only), so the UI
// shows names and can store or replace values, never reveal them.
const SECRET_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function nameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Give the secret a name.';
  if (!SECRET_NAME.test(name)) return 'Use lowercase letters, digits, dots, dashes or underscores, start with a letter or digit, and keep it to 64 characters.';
  return null;
}

/** Secrets (#36): names and metadata, with add, rotate and delete. Values are write-only. */
export default function SecretsPage() {
  useCrumbs([{ label: 'Secrets' }]);
  const { can } = useWorkspace();
  const toast = useToast();
  const list = useApi(() => api.call('secrets.list', {}), []);
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = can('secrets:write');
  const secrets = list.data?.secrets ?? [];

  const remove = async (secret: Secret) => {
    const ok = await confirm({
      title: `Delete secret “${secret.name}”?`,
      body: (
        <>
          Anything that uses it, such as a provider, integration or agent setup, stops working until a new value is stored.
          The value cannot be recovered.
        </>
      ),
      confirmLabel: 'Delete secret',
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api.call('secrets.delete', { name: secret.name });
      toast.success(`Deleted “${secret.name}”. Anything that used it stops working until you store a value again.`);
      void list.reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="Secrets"
        description="Credentials for providers, integrations and agents. Values are encrypted and can never be read back; you can only replace them."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing({ mode: 'add' })}>
              Add secret
            </Button>
          )
        }
      />
      {error && (
        <Alert tone="bad" title="That did not work" className="mb-4" action={<Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}>
          {error}
        </Alert>
      )}
      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        columns={canWrite ? 4 : 3}
        isEmpty={secrets.length === 0}
        empty={
          <EmptyState
            title="No secrets stored"
            action={
              canWrite && (
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing({ mode: 'add' })}>
                  Add secret
                </Button>
              )
            }
          >
            {canWrite
              ? 'Add a provider API key or another credential. People with write access can replace a value later, but nobody can read it back.'
              : 'A person with write access can add a provider API key here. Values are encrypted and never shown.'}
          </EmptyState>
        }
      >
        <Table label="Secrets">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Updated</Th>
              <Th className="hidden md:table-cell">Last changed by</Th>
              {canWrite && (
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              )}
            </tr>
          </THead>
          <tbody>
            {secrets.map((s) => (
              <Tr key={s.name}>
                <Td>
                  <Mono>{s.name}</Mono>
                  <div className="mt-0.5 text-[12px] text-muted md:hidden">{s.updatedByName ?? s.updatedBy}</div>
                </Td>
                <Td className="whitespace-nowrap" title={formatDateTime(s.updatedAt, { seconds: true, zone: true })}>
                  {timeAgo(s.updatedAt)}
                </Td>
                <Td className="hidden md:table-cell">
                  <span>{s.updatedByName ?? <span className="font-mono text-[12px]">{s.updatedBy}</span>}</span>
                </Td>
                {canWrite && (
                  <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={<RotateCw size={14} />} onClick={() => setEditing({ mode: 'rotate', secret: s })}>
                        Rotate
                      </Button>
                      <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => void remove(s)}>
                        Delete
                      </Button>
                    </div>
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {confirmDialog}
      {editing && (
        <SecretDrawer
          key={editing.mode === 'rotate' ? editing.secret.name : 'add'}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void list.reload()}
        />
      )}
    </div>
  );
}

/** The add/rotate drawer: a name (fixed when rotating) and a new value that is never read back. */
function SecretDrawer({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const rotate = editing.mode === 'rotate';
  const secret = editing.mode === 'rotate' ? editing.secret : null;
  const [name, setName] = useState(secret?.name ?? '');
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!rotate) {
      const problem = nameProblem(name);
      if (problem) next.name = problem;
    }
    if (!value) next.value = 'Enter the value to store.';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const storedName = rotate ? secret!.name : name.trim();
      await api.call('secrets.set', { name: storedName, value });
      toast.success(
        rotate
          ? `Replaced the value of “${storedName}”. Anything that uses it picks up the new value on its next call.`
          : `Stored “${storedName}”. It is encrypted and cannot be read back.`,
      );
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') setErrors(fieldErrors(e.details));
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={rotate ? `Replace the value of “${secret!.name}”` : 'Add secret'}
      meta={rotate ? 'The name stays the same; only the value changes.' : 'Values are encrypted and never shown again.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {rotate ? 'Replace value' : 'Add secret'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Name"
          hint={rotate ? 'Secrets keep their name when you rotate them.' : 'Lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit. For example, llm.anthropic.api_key.'}
          error={errors.name}
          required={!rotate}
        >
          <Input
            value={name}
            readOnly={rotate}
            autoComplete="off"
            spellCheck={false}
            data-autofocus={!rotate || undefined}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: '' }));
            }}
            onBlur={(e) => {
              if (rotate) return;
              const problem = nameProblem(e.target.value);
              setErrors((x) => ({ ...x, name: problem ?? '' }));
            }}
          />
        </Field>
        <Field
          label={rotate ? 'New value' : 'Value'}
          hint="Pasted values stay hidden. To change one later, store it again; it cannot be read back."
          error={errors.value}
          required
        >
          <Input
            type={show ? 'text' : 'password'}
            value={value}
            autoComplete="off"
            spellCheck={false}
            data-autofocus={rotate || undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setErrors((x) => ({ ...x, value: '' }));
            }}
            onBlur={() => setErrors((x) => ({ ...x, value: value ? '' : 'Enter the value to store.' }))}
          />
        </Field>
        <Checkbox label="Show while typing" checked={show} onChange={(e) => setShow(e.target.checked)} />
        {error && <Alert tone="bad" title="Not saved">{error}</Alert>}
      </form>
    </Drawer>
  );
}
