import { type BlockCategory, CATEGORY_LABELS } from '../../features/blocks/model';
import { ContentList } from '../../features/phase27/content/ContentList';
import { Field, Select } from '../../ui';

const STARTER = `<mj-section background-color="#ffffff" padding="24px 0">
  <mj-column>
    <mj-text font-size="22px" font-weight="700">{{ block.title }}</mj-text>
    <mj-text font-size="15px" line-height="24px">{{ block.body }}</mj-text>
  </mj-column>
</mj-section>`;

/** Blocks (#446, #526): the reusable-section library as a comparison table. */
export default function BlocksPage() {
  return (
    <ContentList
      type="email_block"
      title="Blocks"
      noun="blocks"
      layout="table"
      description="Reusable headers, footers and sections with typed parameters. Insert one in a template with the “Insert block” menu; editing the block changes every template that uses it, so publish new blocks together with their templates."
      emptyTitle="No blocks yet"
      emptyText="Create a header or footer once and reuse it in every issue. Templates keep the tag, so a later block version is used the next time an e-mail is rendered."
      create={{
        label: 'New block',
        initial: { category: 'header' },
        fields: (state, set, errors) => (
          <Field label="Category" hint="Header, footer, section, call to action, legal or other." error={errors.category} required>
            <Select value={state.category ?? 'header'} onChange={(e) => set({ category: e.target.value })}>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        ),
        content: (_name, state) => ({
          category: (state.category ?? 'header') as BlockCategory,
          mjml: STARTER,
          params: [
            { key: 'title', label: 'Title', type: 'text', default: 'This week' },
            { key: 'body', label: 'Body', type: 'html', default: '<p>Your text here.</p>' },
          ],
        }),
      }}
    />
  );
}
