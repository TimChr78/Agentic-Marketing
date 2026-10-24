import { api, type Out } from '../../app/api';

export type Asset = Out<'assets.list'>['assets'][number];
export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';
const TYPES = new Set(ACCEPT.split(','));

export const formatBytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    r.readAsDataURL(file);
  });
}

/** Uploads one file (#35). The server checks the bytes, type and size; this only filters obvious mistakes. */
export async function uploadFile(file: File, altText?: string): Promise<Asset> {
  if (!TYPES.has(file.type))
    throw new Error(`${file.name} is a ${file.type || 'file of unknown type'}. Upload a PNG, JPEG, GIF, WebP or PDF${file.type === 'image/svg+xml' ? ' (SVG is not allowed because it can carry scripts)' : ''}.`);
  return api.call('assets.upload', { fileName: file.name, contentType: file.type as never, dataBase64: await toBase64(file), ...(altText ? { altText } : {}) });
}
