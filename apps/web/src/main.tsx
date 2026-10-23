import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function render(node: ReactNode) {
  createRoot(document.getElementById('root')!).render(<StrictMode>{node}</StrictMode>);
}

// `--mode live` is the production admin UI served by the image. Every other mode (development and the
// regular/single-file demo builds) keeps the Phase −1 demo. The two literal dynamic imports let
// Rollup drop the branch that is not built, so the live bundle never pulls in the demo.
if (import.meta.env.MODE === 'live') {
  void import('./LiveApp').then(({ default: LiveApp }) => render(<LiveApp />));
} else {
  void import('./App').then(({ default: App }) => render(<App />));
}
