// The block content the UI edits (the server schema lives in packages/artifacts) and the Liquid
// tag a template gets when a block is inserted.

export type BlockCategory = 'header' | 'footer' | 'section' | 'cta' | 'legal' | 'other';
export type BlockParamType = 'text' | 'url' | 'image' | 'color' | 'html';

export interface BlockParam {
  key: string;
  label: string;
  type: BlockParamType;
  required?: boolean;
  default?: string;
  maxLength?: number;
}

export interface BlockContent {
  description?: string;
  category: BlockCategory;
  mjml: string;
  params: BlockParam[];
}

export const CATEGORY_LABELS: Record<BlockCategory, string> = {
  header: 'Header',
  footer: 'Footer',
  section: 'Section',
  cta: 'Call to action',
  legal: 'Legal',
  other: 'Other',
};

export const PARAM_TYPES: { value: BlockParamType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'url', label: 'URL' },
  { value: 'image', label: 'Image URL' },
  { value: 'color', label: 'Colour' },
  { value: 'html', label: 'HTML (raw)' },
];

const PLACEHOLDERS: Record<BlockParamType, string> = {
  text: 'Text',
  url: 'https://example.com',
  image: 'https://example.com/image.png',
  color: '#111827',
  html: '<p>HTML</p>',
};

/** `{% block 'blk_…', title: "This week", … %}` with a placeholder for every declared parameter. */
export function blockTagSnippet(id: string, params: BlockParam[]): string {
  const args = params.map((p) => `${p.key}: ${JSON.stringify(p.default ?? PLACEHOLDERS[p.type])}`).join(', ');
  return `{% block '${id}'${args ? `, ${args}` : ''} %}`;
}
