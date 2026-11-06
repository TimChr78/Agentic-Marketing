import { ArrowRight } from 'lucide-react';
import { CREATE_ACTIONS } from '../app/createIntent';
import { useCrumbs } from '../app/page';
import { navigate } from '../app/router';
import { useSession } from '../app/session';
import { usePageTab } from '../app/useTab';
import { Alert, Button, EmptyState, PageHeader, Tabs } from '../ui';
import { pageWidth } from '../ui/layout';
import RecipesPage from './build/RecipesPage';

const TABS = ['blank', 'starters'] as const;
type Tab = (typeof TABS)[number];

const TAB_ITEMS: { key: Tab; label: string }[] = [
  { key: 'blank', label: 'Blank' },
  { key: 'starters', label: 'Starters' },
];

/**
 * `/create` (#446): the existing recipe gallery wrapped as a create flow, with Blank and Starters
 * tabs. Starters keeps recipe selection/query parameters and never auto-installs; Blank lists the
 * same create actions as the New menu and opens the family's existing dialog.
 */
export default function CreatePage() {
  const { can } = useSession();
  const { active, invalid, select } = usePageTab({ keys: TABS, fallback: 'blank' });
  useCrumbs([{ label: active === 'starters' ? 'Starters' : 'Create' }]);

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Create"
        description="Start from a blank artifact or install a complete marketing loop. Nothing is sent or published until a person approves it."
      />
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={TAB_ITEMS} value={active} onChange={select} label="Create">
        {active === 'starters' ? (
          <RecipesPage embedded />
        ) : can('artifacts:write') ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {CREATE_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.type}
                  type="button"
                  onClick={() => navigate(action.to)}
                  className="flex min-h-16 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-2">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-fg">New {action.label.toLowerCase()}</span>
                    <span className="block text-[12px] text-muted">Opens the existing create flow.</span>
                  </span>
                  <ArrowRight size={16} className="shrink-0 text-muted" aria-hidden />
                </button>
              );
            })}
            <div className="flex min-h-16 items-center gap-3 rounded-lg border border-dashed border-line px-4 py-3">
              <span className="min-w-0 flex-1 text-[13px] text-fg-2">
                Not sure where to start? Open the Starters tab for complete loops.
              </span>
              <Button onClick={() => select('starters')}>Starters</Button>
            </div>
          </div>
        ) : (
          <EmptyState title="Creating artifacts needs artifacts:write">
            Your role can browse the starters, but a builder or admin creates the drafts.
          </EmptyState>
        )}
      </Tabs>
    </div>
  );
}
