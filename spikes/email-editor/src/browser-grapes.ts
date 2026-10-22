import grapesjs from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';

// Import MJML into the GrapesJS MJML editor and export it again, optionally after a user edit.
(window as any).roundtripGrapes = async (mjml: string, edit: boolean) => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = grapesjs.init({ container: el, height: '900px', storageManager: false, fromElement: false, plugins: [grapesjsMjml], components: mjml });
  await new Promise<void>((resolve) => editor.onReady(() => resolve()));
  if (edit) {
    // What a marketer does: add a sentence to the first text block.
    const first = editor.getWrapper()!.findType('mj-text')[0];
    first.append({ type: 'textnode', content: ' Edited in the visual editor.' });
  }
  const out = editor.getHtml();
  editor.destroy();
  el.remove();
  return out;
};
