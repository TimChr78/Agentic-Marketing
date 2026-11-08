import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { isDemoEntry } from './features/phase27/demo/entry';

function render(node: ReactNode) {
  createRoot(document.getElementById('root')!).render(<StrictMode>{node}</StrictMode>);
}

// `/demo` runs the real shell and the seeded fixture reads; the single-file build is the same demo
// alone. Everything else is the real workspace, so the demo's fixture code is never part of a
// normal admin route's initial load.
if (isDemoEntry()) {
  document.title = 'Agentic Marketing demo';
  void import('./features/phase27/integration/demo/DemoRoot').then(({ DemoRoot }) => render(<DemoRoot />));
} else {
  void import('./app/Root').then(({ Root }) => render(<Root />));
}
