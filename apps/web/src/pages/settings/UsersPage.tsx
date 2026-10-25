import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useApi } from '../../app/useApi';
import { useWorkspace } from '../../app/session';
import { ROLE_MEANING, ROLE_LABEL, ROLES, type Role, lowersAdmin, roleLabel } from '../../features/settings/roles';
import {
  Alert,
  Button,
  Card,
  Drawer,
  EmptyState,
  Field,
  FieldGroup,
  fieldErrors,
  IconButton,
  Input,
  LoadingBlock,
  PageHeader,
  RadioCards,
  Select,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  Td,
  Th,
  THead,
  timeAgo,
  Tr,
  useConfirm,
  useToast,
  formatDate,
} from '../../ui';

type Member = Out<'members.list'>['members'][number];
type Invitation = Out<'invitations.list'>['invitations'][number];

const personName = (m: Member) => m.name || m.email || 'This person';

/** Users and roles: members, inline role changes, invitations and read-only identity info. */
export default function UsersPage() {
  useCrumbs([{ label: 'Users and roles' }]);
  const { user, workspace, can } = useWorkspace();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const data = useApi(async () => {
    const [members, invitations, sso, scim] = await Promise.all([
      api.call('members.list', {}),
      api.call('invitations.list', { status: 'pending' }),
      api.call('sso.list', {}).catch(() => null),
      api.call('scim.status', {}).catch(() => null),
    ]);
    return { members: members.members, invitations: invitations.invitations, sso: sso?.providers ?? null, scim };
  }, []);
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOwner = workspace.you.role === 'owner';
  const isSelf = (m: Member) => m.userId === user.id;
  const mayChangeRole = (m: Member) => !isSelf(m) && (m.role !== 'owner' || isOwner);
  const roleBlockReason = (m: Member) =>
    isSelf(m) ? 'You cannot change your own role.' : m.role === 'owner' && !isOwner ? 'Only an owner can change another owner.' : undefined;
  const mayRemove = (m: Member) => !isSelf(m) && (m.role !== 'owner' || isOwner);
  const removeBlockReason = (m: Member) =>
    isSelf(m) ? 'You cannot remove yourself. Ask another admin or an owner.' : m.role === 'owner' && !isOwner ? 'Only an owner can remove an owner.' : undefined;

  const members = data.data?.members ?? [];
  const invitations = data.data?.invitations ?? [];

  const changeRole = async (m: Member, role: Role) => {
    if (role === m.role) return;
    if (lowersAdmin(m.role, role)) {
      const ok = await confirm({
        title: `Change ${personName(m)} from ${ROLE_LABEL[m.role]} to ${ROLE_LABEL[role]}?`,
        body: (
          <>
            They lose the access that came with the {ROLE_LABEL[m.role]} role, including settings if they had it. You can give
            it back later.
          </>
        ),
        confirmLabel: 'Change role',
      });
      if (!ok) return;
    }
    setBusyId(m.userId);
    setError(null);
    try {
      await api.call('members.setRole', { userId: m.userId, role });
      toast.success(`Changed ${personName(m)} to ${ROLE_LABEL[role]}.`);
      void data.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (m: Member) => {
    const ok = await confirm({
      title: `Remove ${personName(m)} from the workspace?`,
      body: (
        <>
          Their sessions and connected agents lose access immediately. Content they created stays in the workspace. You can
          invite them again later.
        </>
      ),
      confirmLabel: 'Remove person',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(m.userId);
    setError(null);
    try {
      await api.call('members.remove', { userId: m.userId });
      toast.success(`Removed ${personName(m)}. Their sessions and agents no longer have access.`);
      void data.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (inv: Invitation) => {
    const ok = await confirm({
      title: `Revoke the invitation for ${inv.email}?`,
      body: <>The link stops working. You can invite them again if it was a mistake.</>,
      confirmLabel: 'Revoke invitation',
      destructive: true,
    });
    if (!ok) return;
    setRevoking(inv.id);
    setError(null);
    try {
      await api.call('invitations.revoke', { id: inv.id });
      toast.success(`Revoked the invitation for ${inv.email}. The link no longer works.`);
      void data.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Users and roles"
        description="People in this workspace and what they can do. An invitation creates a one-time link to share; no e-mail is sent."
        actions={
          can('workspace:admin') && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setInviting(true)}>
              Invite person
            </Button>
          )
        }
      />
      {error && (
        <Alert tone="bad" title="That did not work" className="mb-4">
          {error}
        </Alert>
      )}
      <TableFrame
        loading={data.loading}
        error={data.error}
        onRetry={data.reload}
        columns={4}
        isEmpty={members.length === 0}
        empty={<EmptyState title="No members">Invite a person to give them access to this workspace.</EmptyState>}
      >
        <Table label="Members">
          <THead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th className="hidden md:table-cell">Member since</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {members.map((m) => (
              <Tr key={m.userId}>
                <Td>
                  <div className="font-medium text-fg">
                    {personName(m)}
                    {isSelf(m) && <span className="ml-1.5 text-[12px] font-normal text-muted">(you)</span>}
                  </div>
                  <div className="mt-0.5 text-[12px] break-all text-muted">{m.email}</div>
                </Td>
                <Td>
                  <span title={roleBlockReason(m)} className="inline-block">
                    <Select
                      compact
                      aria-label={`Role for ${personName(m)}`}
                      value={m.role}
                      disabled={!mayChangeRole(m) || busyId === m.userId}
                      onChange={(e) => void changeRole(m, e.target.value as Role)}
                      className="w-auto"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r} disabled={r === 'owner' && !isOwner}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                  </span>
                </Td>
                <Td className="hidden whitespace-nowrap md:table-cell">{formatDate(m.since)}</Td>
                <Td className="text-right">
                  <span title={removeBlockReason(m)} className="inline-block">
                    <IconButton
                      size="sm"
                      variant="danger"
                      label={`Remove ${personName(m)}`}
                      icon={<Trash2 size={15} />}
                      disabled={!mayRemove(m) || busyId === m.userId}
                      onClick={() => void remove(m)}
                    />
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card
          title="Pending invitations"
          description="One-time links that have not been accepted yet."
          action={
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setInviting(true)}>
              Invite person
            </Button>
          }
        >
          {data.loading ? (
            <LoadingBlock lines={2} label="Loading invitations" />
          ) : !data.data ? (
            <p className="p-4 text-[13px] text-muted">Invitations are unavailable while the list of people cannot be loaded.</p>
          ) : invitations.length === 0 ? (
            <p className="p-4 text-[13px] text-muted">No pending invitations. Invite someone to give them access.</p>
          ) : (
            <ul className="divide-y divide-line">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-start gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium break-all text-fg">{inv.email}</span>
                      <Tag>{ROLE_LABEL[inv.role]}</Tag>
                      {inv.status === 'expired' && <StatusPill tone="warn">Expired</StatusPill>}
                    </div>
                    <p className="mt-0.5 text-[12px] text-muted">
                      Sent {timeAgo(inv.createdAt)} · expires {formatDate(inv.expiresAt)}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" loading={revoking === inv.id} onClick={() => void revoke(inv)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Single sign-on and provisioning"
          description="Read-only here. Set providers up in your identity provider and configure them through the API."
        >
          <div className="space-y-4 p-4">
            <div>
              <h3 className="text-[12px] font-medium text-fg-2">Single sign-on</h3>
              {!data.data ? (
                <p className="mt-1 text-[13px] text-muted">Unavailable.</p>
              ) : !data.data.sso ? (
                <p className="mt-1 text-[13px] text-muted">Could not read the providers.</p>
              ) : data.data.sso.length === 0 ? (
                <p className="mt-1 text-[13px] text-muted">No providers. People sign in with e-mail and password.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {data.data.sso.map((p) => (
                    <li key={p.providerId} className="text-[13px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium break-all text-fg">{p.domain}</span>
                        <Tag>{p.type.toUpperCase()}</Tag>
                        {!p.domainVerified && <StatusPill tone="warn">Domain not verified</StatusPill>}
                      </div>
                      <p className="mt-0.5 text-[12px] text-muted">
                        New people get {roleLabel(p.defaultRole)}
                        {p.enforced ? ' · passwords are turned off for this domain' : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-[12px] font-medium text-fg-2">SCIM provisioning</h3>
              {!data.data ? (
                <p className="mt-1 text-[13px] text-muted">Unavailable.</p>
              ) : !data.data.scim ? (
                <p className="mt-1 text-[13px] text-muted">Could not read the provisioning status.</p>
              ) : !data.data.scim.configured || !data.data.scim.enabled ? (
                <p className="mt-1 text-[13px] text-muted">Off. Members are managed here and through single sign-on.</p>
              ) : (
                <p className="mt-1 text-[13px] text-muted">
                  On. {data.data.scim.users} {data.data.scim.users === 1 ? 'person' : 'people'} and {data.data.scim.groups}{' '}
                  {data.data.scim.groups === 1 ? 'group' : 'groups'} are managed by your identity provider. New people get the{' '}
                  {roleLabel(data.data.scim.defaultRole)} role.
                </p>
              )}
            </div>
          </div>
        </Card>
      </div>

      {confirmDialog}
      {inviting && (
        <InviteDrawer
          isOwner={isOwner}
          onClose={() => setInviting(false)}
          onInvited={() => void data.reload()}
        />
      )}
    </div>
  );
}

/** Invite a person: e-mail and role, then the one-time link the command returns. */
function InviteDrawer({ isOwner, onClose, onInvited }: { isOwner: boolean; onClose: () => void; onInvited: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('marketer');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState<{ email: string; link: string; expiresAt: string } | null>(null);

  const emailProblem = (value: string) => {
    const address = value.trim();
    if (!address) return 'Enter an e-mail address.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return 'Enter a valid e-mail address, such as ada@example.com.';
    return null;
  };

  const submit = async () => {
    const problem = emailProblem(email);
    if (problem) {
      setErrors({ email: problem });
      return;
    }
    const address = email.trim().toLowerCase();
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('members.invite', { email: address, role });
      setInvited({ email: address, link: new URL(r.acceptPath, location.origin).href, expiresAt: r.expiresAt });
      onInvited();
      toast.success(`Created an invitation for ${address}. The link is shown once.`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') setErrors(fieldErrors(e.details));
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invited) return;
    try {
      await navigator.clipboard.writeText(invited.link);
      toast.success('Invitation link copied.');
    } catch {
      toast.error('Could not copy the link. Select it and copy it yourself.');
    }
  };

  const roleOptions = ROLES.filter((r) => r !== 'owner' || isOwner).map((r) => ({
    value: r,
    label: ROLE_LABEL[r],
    hint: ROLE_MEANING[r],
  }));

  return (
    <Drawer
      open
      onClose={onClose}
      title="Invite person"
      meta={invited ? 'The invitation is ready to share.' : 'Creates a one-time link, valid for 7 days.'}
      footer={
        invited ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              Create invitation
            </Button>
          </>
        )
      }
    >
      {invited ? (
        <div className="space-y-4 p-5">
          <Alert tone="good" title="Invitation created">
            Share this link with {invited.email}. It works once, only with that e-mail address, and expires on{' '}
            {formatDate(invited.expiresAt)}. No e-mail is sent.
          </Alert>
          <Field label="Invitation link" hint="Shown only now. Copy it before you close this drawer.">
            <div className="flex gap-2">
              <Input readOnly value={invited.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
              <Button icon={<Copy size={14} />} onClick={() => void copy()}>
                Copy
              </Button>
            </div>
          </Field>
        </div>
      ) : (
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field
            label="E-mail address"
            hint="They accept the invitation while signed in with this address."
            error={errors.email}
            required
          >
            <Input
              type="email"
              value={email}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              onChange={(e) => {
                setEmail(e.target.value);
                setErrors((x) => ({ ...x, email: '' }));
              }}
              onBlur={(e) => {
                const problem = emailProblem(e.target.value);
                setErrors((x) => ({ ...x, email: problem ?? '' }));
              }}
            />
          </Field>
          <FieldGroup legend="Role" hint="What they can do after they accept. You can change it later.">
            <RadioCards name="invite-role" value={role} onChange={setRole} options={roleOptions} />
          </FieldGroup>
          {error && (
            <Alert tone="bad" title="Not invited">
              {error}
            </Alert>
          )}
        </form>
      )}
    </Drawer>
  );
}
