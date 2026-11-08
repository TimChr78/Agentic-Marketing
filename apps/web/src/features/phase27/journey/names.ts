import { getWorkspaceId } from '../../../app/api';
import { peekPickerIndex } from '../../artifacts/pickerIndex';

// A step's summary may name the artifact it references. It must never read `artifacts.get` per
// node (#528). The shared picker index already holds the name once its selector has been opened;
// before then the summary shows the id, and the name appears as soon as the index is loaded.
const TYPE_BY_PREFIX: Record<string, string> = {
  seg: 'segment',
  eml: 'email_template',
  sms: 'sms_template',
  psh: 'push_template',
  prm: 'prompt',
};

export function artifactNameFromIndex(id: string, workspaceId = getWorkspaceId() ?? ''): string | undefined {
  if (!workspaceId) return undefined;
  const type = TYPE_BY_PREFIX[id.slice(0, 3)];
  if (!type) return undefined;
  return peekPickerIndex(workspaceId, type)?.artifacts.find((a) => a.id === id)?.name;
}
