import { MjmlToJson } from 'easy-email-extensions';
import { JsonToMjml } from 'easy-email-core';

// Easy Email stores its own JSON block tree; MJML goes in via MjmlToJson and out via JsonToMjml.
(window as any).roundtripEasy = (mjml: string, edit: boolean) => {
  const page: any = MjmlToJson(mjml);
  if (edit) {
    const findText = (b: any): any => (b.type === 'text' ? b : (b.children ?? []).map(findText).find(Boolean));
    const first = findText(page);
    if (first) first.data.value.content += ' Edited in the visual editor.';
  }
  return JsonToMjml({ data: page, mode: 'production', context: page, dataSource: {} });
};
