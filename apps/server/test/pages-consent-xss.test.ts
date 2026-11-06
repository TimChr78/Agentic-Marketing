import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { consentPage } from '../src/http/pages';

// #478: the OAuth consent page fetched brand names and wrote them into `innerHTML`, so a brand
// named `<img onerror=…>` ran script in the platform origin. The page must build elements with the
// DOM API and put every value in with `textContent`; the inline script must never parse HTML.

/** The workspace name a brand owner controls, inside the 120-character limit. */
const PAYLOAD = '<img src=x onerror="alert(1)">';

function scriptOf(html: string): string {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

async function renderConsent(
  workspaces: { id: string; name: string; role: string }[],
  query = 'client_id=test-client&scope=artifacts%3Aread',
) {
  const window = new Window({ url: `https://am.example.com/consent?${query}` });
  const page = consentPage('test-nonce');
  window.document.write(page);
  // Browsers expose elements by id as globals; the page relies on that. The page declares
  // brandSelect itself, so the bridge only supplies the rest.
  const bridge = `const who = document.getElementById('who'), scopes = document.getElementById('scopes'),
    err = document.getElementById('err'), yes = document.getElementById('yes'), no = document.getElementById('no'),
    f = document.getElementById('f');`;
  const requested: { url: string; body: string }[] = [];
  Object.assign(window, {
    fetch: async (url: string, init: RequestInit) => {
      requested.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ workspaces }), { headers: { 'content-type': 'application/json' } });
    },
  });
  window.eval(`${bridge}\n${scriptOf(page)}`);
  await window.happyDOM.waitUntilComplete();
  return { window, document: window.document, requested };
}

describe('consent page renders brand names as text (#478)', () => {
  it('never builds HTML from the workspace list', async () => {
    const { document } = await renderConsent([{ id: '11111111-1111-1111-1111-111111111111', name: PAYLOAD, role: 'owner' }]);
    // The payload is shown exactly as text and parses into no element and no handler attribute.
    const select = document.getElementById('workspace') as unknown as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
    expect(select.options[0].textContent).toContain(PAYLOAD);
    expect(select.options[0].textContent).toContain('(owner)');
    expect(select.querySelector('img')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
    expect(document.querySelector('[src="x"]')).toBeNull();
    expect(select.options[0].value).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('does not concatenate HTML anywhere in the page script', () => {
    const script = scriptOf(consentPage('test-nonce'));
    expect(script).not.toMatch(/innerHTML/);
    expect(script).not.toMatch(/insertAdjacentHTML/);
    expect(script).not.toMatch(/outerHTML/);
  });

  it('builds the requested scope rows without parsing the scope string as HTML', async () => {
    const { document } = await renderConsent([{ id: '11111111-1111-1111-1111-111111111111', name: 'Brand', role: 'owner' }]);
    const boxes = [...document.querySelectorAll('#scopes input[type=checkbox]')] as unknown as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual(['artifacts:read']);
    expect(document.querySelector('#scopes label.scope code')?.textContent).toBe('artifacts:read');
  });
});
