import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function render(node: ReactNode) {
  createRoot(document.getElementById('root')!).render(<StrictMode>{node}</StrictMode>);
}

// The demo (sample data, mocked backend) is a separate bundle at /demo, linked only from the
// sign-in page; the single-file build is the demo alone. Everything else is the real workspace.
const isDemo = import.meta.env.MODE === 'single' || location.pathname === '/demo' || location.pathname.startsWith('/demo/');
if (isDemo) {
  document.title = 'Agentic Marketing demo';
  void import('./App').then(({ default: App }) => render(<App />));
} else {
  void import('./app/Root').then(({ Root }) => render(<Root />));
}
