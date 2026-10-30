import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// Light asset library (issue #35): upload, list, usage, delete and the public /a link. Ports are
// unique to this file; the harness starts a real server on a fresh database.

const MAIN_PORT = testPort(3403);
const PUBLIC_PORT = testPort(3404);

type AssetContentType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml' | 'application/pdf';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let api: ReturnType<typeof t.api>;

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function gif(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.write('GIF89a', 0, 'latin1');
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  data[12] = 0x3b;
  return data;
}

function webp(width: number, height: number): Buffer {
  const data = Buffer.alloc(30);
  data.write('RIFF', 0, 'latin1');
  data.writeUInt32LE(22, 4);
  data.write('WEBP', 8, 'latin1');
  data.write('VP8X', 12, 'latin1');
  data.writeUInt32LE(10, 16);
  data.writeUIntLE(width - 1, 24, 3);
  data.writeUIntLE(height - 1, 27, 3);
  return data;
}

const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const upload = (fileName: string, contentType: AssetContentType, data: Buffer, extra: { name?: string; altText?: string } = {}) =>
  api.call('assets.upload', { fileName, contentType, dataBase64: data.toString('base64'), ...extra });

const rest = (name: string, body: unknown, token?: string) =>
  fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  t = await startTestServer('test_assets02', MAIN_PORT, { ASSET_MAX_BYTES: '1048576', PUBLIC_PORT: String(PUBLIC_PORT) });
  owner = await t.signUp(`assets-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  api = t.api(owner);
}, 60_000);
afterAll(() => t?.close());

describe('assets.upload', () => {
  it('stores images and PDFs with their size and dimensions', async () => {
    const pngBytes = png(3, 2);
    const image = await upload('hero.png', 'image/png', pngBytes, { name: 'Hero image', altText: 'A red tent' });
    expect(image.id).toMatch(/^ast_[0-9a-f]{32}$/);
    expect(image).toMatchObject({
      name: 'Hero image',
      fileName: 'hero.png',
      contentType: 'image/png',
      kind: 'image',
      byteSize: pngBytes.length,
      width: 3,
      height: 2,
      altText: 'A red tent',
      usageCount: 0,
      createdBy: owner.id,
    });
    expect(image.url).toBe(`http://localhost:${MAIN_PORT}/a/${image.id}/hero.png`);
    expect(new Date(image.createdAt).toString()).not.toBe('Invalid Date');

    const jpegImage = await upload('photo.jpg', 'image/jpeg', jpeg(640, 480));
    expect(jpegImage).toMatchObject({ kind: 'image', width: 640, height: 480, altText: '' });
    expect(jpegImage.name).toBe('photo');

    const gifImage = await upload('sticker.gif', 'image/gif', gif(7, 5));
    expect(gifImage).toMatchObject({ width: 7, height: 5 });

    const webpImage = await upload('picture.webp', 'image/webp', webp(320, 240));
    expect(webpImage).toMatchObject({ width: 320, height: 240 });

    const document = await upload('price-list.pdf', 'application/pdf', pdf);
    expect(document).toMatchObject({
      name: 'price-list',
      kind: 'file',
      contentType: 'application/pdf',
      width: null,
      height: null,
      byteSize: pdf.length,
    });

    const sanitised = await upload('../../etc/passwd.png', 'image/png', png(1, 1));
    expect(sanitised.fileName).toBe('passwd.png');
    expect(sanitised.url.endsWith('/passwd.png')).toBe(true);
  });

  it('refuses a declared type that does not match the bytes, and an oversized file', async () => {
    expect((await rejects(upload('wrong.png', 'image/jpeg', png(1, 1)))).message).toMatch(
      /The file is a image\/png, not the declared image\/jpeg/,
    );
    expect((await rejects(upload('garbage.png', 'image/png', Buffer.from('not an image')))).message).toMatch(
      /not a PNG, JPEG, GIF, WebP, SVG or PDF/,
    );
    expect((await rejects(upload('not-an-svg.svg', 'image/svg+xml', Buffer.from('<div>no</div>')))).message).toMatch(
      /not an SVG: an SVG is XML whose root element is <svg>/,
    );

    const tooBig = Buffer.alloc(1024 * 1024 + 1);
    expect((await rejects(upload('big.png', 'image/png', tooBig))).message).toMatch(/over the 1 MB limit/);
  });

  it('refuses a request body that is too large before reading it', async () => {
    const res = await fetch(`${t.base}/v1/assets.upload`, {
      method: 'POST',
      // Close the socket: the server rejects the body by size and does not read the rest of it.
      headers: { 'content-type': 'application/json', cookie: owner.cookie, connection: 'close' },
      body: JSON.stringify({
        fileName: 'huge.png',
        contentType: 'image/png',
        dataBase64: Buffer.alloc(1_200_000).toString('base64'),
      }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    expect((await rejects(api.call('assets.upload', {} as never))).code).toBe('invalid_input');
  });

  it('lets an agent API token with artifacts:write upload', async () => {
    const token = await api.call('apiTokens.create', { name: 'asset agent', scopes: ['artifacts:read', 'artifacts:write'] });
    const res = await rest(
      'assets.upload',
      { fileName: 'agent.pdf', contentType: 'application/pdf', dataBase64: pdf.toString('base64') },
      token.token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ contentType: 'application/pdf', kind: 'file' });
  });
});

describe('SVG logos', () => {
  const svg = (body: string, attributes = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"') =>
    Buffer.from(`<svg ${attributes}>${body}</svg>`);

  it('uploads a plain SVG, records its size and stores a PNG rendition at 2x', async () => {
    const asset = await upload('logo.svg', 'image/svg+xml', svg('<rect width="120" height="40" fill="#123456"/>'));
    expect(asset).toMatchObject({
      fileName: 'logo.svg',
      contentType: 'image/svg+xml',
      kind: 'image',
      width: 120,
      height: 40,
      sanitized: [],
    });
    expect(asset.rendition).toMatchObject({ contentType: 'image/png', width: 240, height: 80 });
    expect(asset.url).toBe(`${t.base}/a/${asset.id}/logo.svg`);
    expect(asset.rendition!.url).toBe(`${t.base}/a/${asset.id}/logo.png`);

    // The served files keep the sandbox headers, and each says what it is.
    const original = await fetch(asset.url);
    expect(original.status).toBe(200);
    expect(original.headers.get('content-type')).toBe('image/svg+xml');
    expect(original.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    expect(original.headers.get('x-content-type-options')).toBe('nosniff');
    expect(original.headers.get('content-disposition')).toBe('inline; filename="logo.svg"');

    const rendition = await fetch(asset.rendition!.url);
    expect(rendition.status).toBe(200);
    expect(rendition.headers.get('content-type')).toBe('image/png');
    expect(rendition.headers.get('x-content-type-options')).toBe('nosniff');
    expect(rendition.headers.get('content-disposition')).toBe('inline; filename="logo.png"');
    const pngBytes = Buffer.from(await rendition.arrayBuffer());
    expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngBytes.readUInt32BE(16)).toBe(240);
    expect(pngBytes.readUInt32BE(20)).toBe(80);
  });

  it('drops a script and says so', async () => {
    const asset = await upload('script.svg', 'image/svg+xml', svg('<script>alert(1)</script><rect width="10" height="10"/>'));
    expect(asset.sanitized).toContain('script');
    const served = await (await fetch(asset.url)).text();
    expect(served).not.toContain('<script');
    expect(served).toContain('<rect');
  });

  it('drops an event-handler attribute and says so', async () => {
    const asset = await upload(
      'onload.svg',
      'image/svg+xml',
      svg('<rect width="10" height="10"/>', 'xmlns="http://www.w3.org/2000/svg" onload="alert(1)"'),
    );
    expect(asset.sanitized).toContain('onload attribute');
    expect(await (await fetch(asset.url)).text()).not.toContain('onload');
  });

  it('drops an external href but keeps a drawable shape', async () => {
    const asset = await upload(
      'href.svg',
      'image/svg+xml',
      svg('<use href="https://evil.example/x.svg#p"/><rect width="10" height="10"/>'),
    );
    expect(asset.sanitized).toContain('href attribute');
    const served = await (await fetch(asset.url)).text();
    expect(served).not.toContain('evil.example');
    expect(served).toContain('<rect');
  });

  it('drops foreignObject and its contents', async () => {
    const asset = await upload(
      'foreign.svg',
      'image/svg+xml',
      svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><rect width="10" height="10"/>'),
    );
    expect(asset.sanitized).toContain('foreignObject');
    expect(await (await fetch(asset.url)).text()).not.toContain('foreignObject');
  });

  it('refuses a DOCTYPE outright, because entities expand on the server', async () => {
    const doctype = Buffer.from('<!DOCTYPE svg [<!ENTITY boom "boom">]><svg xmlns="http://www.w3.org/2000/svg"><text>&boom;</text></svg>');
    expect((await rejects(upload('entity.svg', 'image/svg+xml', doctype))).message).toMatch(/DOCTYPE is refused|DOCTYPE are refused/);
  });

  it('drops a style with @import and says so', async () => {
    const asset = await upload(
      'style.svg',
      'image/svg+xml',
      svg('<style>@import url(https://evil.example/x.css);</style><rect width="10" height="10"/>'),
    );
    expect(asset.sanitized.join(' ')).toMatch(/style with @import/);
    expect(await (await fetch(asset.url)).text()).not.toContain('@import');
  });

  it('refuses an SVG with no drawable content left', async () => {
    expect(await rejects(upload('empty.svg', 'image/svg+xml', svg('<script>alert(1)</script>')))).toMatchObject({
      message: expect.stringMatching(/no drawable content/i),
    });
  });

  it('gives e-mail the PNG rendition and hosted pages the SVG', async () => {
    const logo = await upload('brand.svg', 'image/svg+xml', svg('<path d="M0 0h120v40H0z"/>'));
    const template = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Logo e-mail',
      content: {
        purpose: 'onboarding',
        subject: 'Hello',
        mjml: `<mjml><mj-body><mj-section><mj-column><mj-image src="${logo.url}" alt="Logo" /></mj-column></mj-section></mj-body></mjml>`,
      },
    });
    const email = await api.call('templates.preview', { artifactId: template.artifactId });
    expect(email.html).toContain(logo.rendition!.url);
    expect(email.html).not.toContain(logo.url);

    const page = await api.call('hostedPages.preview', {
      page: 'confirmed',
      brand: { siteName: 'SVG Co', logoUrl: logo.url },
    });
    expect(page.html).toContain(`src="${logo.url}"`);
    expect(page.html).not.toContain(logo.rendition!.url);
  });
});

describe('assets.list', () => {
  it('searches name, file name and alt text, filters by kind and pages with a cursor', async () => {
    await upload('pagination-a.png', 'image/png', png(1, 1), { name: 'Pagination A', altText: 'first' });
    await upload('pagination-b.png', 'image/png', png(1, 1), { name: 'Pagination B', altText: 'second' });
    await upload('pagination-c.pdf', 'application/pdf', pdf, { name: 'Pagination C', altText: 'third' });

    const first = await api.call('assets.list', { query: 'pagination', limit: 2 });
    expect(first.assets).toHaveLength(2);
    expect(first.assets.map((a) => a.name)).toEqual(['Pagination C', 'Pagination B']);
    expect(first.nextCursor).not.toBeNull();
    const second = await api.call('assets.list', { query: 'pagination', limit: 2, cursor: first.nextCursor! });
    expect(second.assets.map((a) => a.name)).toEqual(['Pagination A']);
    expect(second.nextCursor).toBeNull();

    // Case-insensitive across file name and alt text too.
    expect((await api.call('assets.list', { query: 'PAGINATION-B' })).assets.map((a) => a.fileName)).toEqual(['pagination-b.png']);
    expect((await api.call('assets.list', { query: 'thi' })).assets.map((a) => a.name)).toContain('Pagination C');

    const images = await api.call('assets.list', { query: 'pagination', kind: 'image' });
    expect(images.assets.every((a) => a.kind === 'image')).toBe(true);
    const files = await api.call('assets.list', { query: 'pagination', kind: 'file' });
    expect(files.assets.map((a) => a.name)).toEqual(['Pagination C']);

    expect((await rejects(api.call('assets.list', { cursor: 'not-a-cursor' }))).message).toMatch(/cursor is not valid/i);
  });
});

describe('usage and delete', () => {
  it('reports where an asset is used and refuses to delete it without force', async () => {
    const asset = await upload('welcome.png', 'image/png', png(4, 3), { name: 'Welcome image', altText: 'Welcome' });
    const draft = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Welcome e-mail',
      content: {
        purpose: 'onboarding',
        subject: 'Welcome',
        mjml: `<mjml><mj-body><mj-section><mj-column><mj-image src="${asset.url}" alt="${asset.altText}" /></mj-column></mj-section></mj-body></mjml>`,
      },
    });

    const got = await api.call('assets.get', { id: asset.id });
    expect(got.usageCount).toBe(1);
    expect(got.usage).toEqual([
      { artifactId: draft.artifactId, artifactName: 'Welcome e-mail', artifactType: 'email_template', versions: ['latest'] },
    ]);
    expect((await api.call('assets.list', { query: 'welcome' })).assets.find((a) => a.id === asset.id)?.usageCount).toBe(1);

    const refused = await rejects(api.call('assets.delete', { id: asset.id }));
    expect(refused.code).toBe('conflict');
    expect(refused.message).toMatch(/Used in 1 artifact: Welcome e-mail \(email_template\)/);
    expect(refused.message).toMatch(/force: true/);

    // An agent may never force; a person may.
    const token = await api.call('apiTokens.create', { name: 'delete agent', scopes: ['artifacts:read', 'artifacts:write'] });
    const forced = await rest('assets.delete', { id: asset.id, force: true }, token.token);
    expect(forced.status).toBe(403);
    expect((await forced.json()).message).toMatch(/Agents cannot force-delete/);
    expect((await rest('assets.delete', { id: asset.id }, token.token)).status).toBe(409);

    expect(await api.call('assets.delete', { id: asset.id, force: true })).toEqual({ deleted: true });
    expect((await rejects(api.call('assets.get', { id: asset.id }))).code).toBe('not_found');
    expect((await api.call('assets.list', { query: 'welcome' })).assets).toHaveLength(0);
    const gone = await fetch(asset.url);
    expect(gone.status).toBe(410);
  });

  it('updates only the name and alt text', async () => {
    const asset = await upload('rename.png', 'image/png', png(2, 2));
    const updated = await api.call('assets.update', { id: asset.id, name: 'Renamed', altText: 'New alt' });
    expect(updated).toMatchObject({ id: asset.id, name: 'Renamed', altText: 'New alt', byteSize: asset.byteSize });
    expect((await rejects(api.call('assets.update', { id: asset.id }))).code).toBe('invalid_input');
    expect((await rejects(api.call('assets.update', { id: 'ast_00000000000000000000000000000000', name: 'x' }))).code).toBe('not_found');
  });
});

describe('public /a links', () => {
  it('serves bytes with cache and safety headers, HEAD included, and 304 for a matching ETag', async () => {
    const bytes = png(5, 4);
    const asset = await upload('public.png', 'image/png', bytes, { altText: 'Public' });

    const res = await fetch(asset.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="public.png"');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);

    // The file name segment is cosmetic: the id is what identifies the asset.
    expect((await fetch(`http://localhost:${MAIN_PORT}/a/${asset.id}`)).status).toBe(200);
    expect((await fetch(`http://localhost:${MAIN_PORT}/a/${asset.id}/another-name.png`)).status).toBe(200);

    const head = await fetch(asset.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
    expect(await head.text()).toBe('');

    const cached = await fetch(asset.url, { headers: { 'if-none-match': res.headers.get('etag')! } });
    expect(cached.status).toBe(304);

    // The public-only listener serves /a as well; unknown ids are 404 and never the admin API.
    const viaPublic = await fetch(`http://localhost:${PUBLIC_PORT}/a/${asset.id}/public.png`);
    expect(viaPublic.status).toBe(200);
    expect((await viaPublic.arrayBuffer()).byteLength).toBe(bytes.length);
    expect((await fetch(`http://localhost:${MAIN_PORT}/a/ast_00000000000000000000000000000000`)).status).toBe(404);
    expect((await fetch(`http://localhost:${MAIN_PORT}/a/not-an-asset`)).status).toBe(404);
  });
});
