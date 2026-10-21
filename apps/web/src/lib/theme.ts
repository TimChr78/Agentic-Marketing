import { useEffect, useState } from 'react';

export type Resolved = 'light' | 'dark';

function resolve(): Resolved {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Resolved theme: the viewer's explicit data-theme choice, else the OS preference. */
export function useTheme(): Resolved {
  const [theme, setTheme] = useState<Resolved>(resolve);
  useEffect(() => {
    const update = () => setTheme(resolve());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', update);
      mo.disconnect();
    };
  }, []);
  return theme;
}
