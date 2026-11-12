import { useState } from 'react';
import { api, errText } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { navigate } from '../../app/router';
import { Alert, Button, Field, Input, Modal, useToast } from '../../ui';
import { notifyArtifactsChanged } from '../artifactCache';
import { ArtifactSelect } from '../artifacts/ArtifactSelect';

// The current broadcast create form (#448): a name, a published e-mail template and a segment.
// The list action and the `?create=broadcast` intent both open this same dialog; it creates a draft
// and navigates to it, never publishing or sending.

interface DraftState {
  template?: string;
  segment?: string;
}

export function CreateBroadcastDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [state, setState] = useState<DraftState>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const next: Record<string, string> = {
      ...(state.template ? {} : { template: 'Choose the e-mail to send.' }),
      ...(state.segment ? {} : { segment: 'Choose who gets it.' }),
    };
    setErrors(next);
    if (!name.trim()) setNameError('Give it a name people will recognise.');
    if (!name.trim() || Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('artifacts.create', {
        type: 'broadcast',
        name: name.trim(),
        content: { template: state.template, segment: state.segment },
      });
      notifyArtifactsChanged(r.artifactId);
      toast.success(`Created “${name.trim()}” as a draft.`);
      onClose();
      navigate(artifactPath('broadcast', r.artifactId));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New broadcast"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" mutation loading={busy} onClick={submit}>
            Create draft
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" error={nameError} hint="Shown to reviewers and agents." required>
          <Input
            value={name}
            data-autofocus
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            onBlur={() => !name.trim() && setNameError('Give it a name people will recognise.')}
            maxLength={120}
          />
        </Field>
        <Field label="Template" error={errors.template} required>
          <ArtifactSelect type="email_template" value={state.template} onChange={(template) => setState({ ...state, template })} />
        </Field>
        <Field label="Segment" error={errors.segment} required>
          <ArtifactSelect type="segment" value={state.segment} onChange={(segment) => setState({ ...state, segment })} />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
