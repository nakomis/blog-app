/**
 * Light/dark switch (BAPP-10).
 *
 * Three states rather than two: light, dark, and "follow the system", which is
 * the default and the only one that keeps tracking the OS if the reader
 * changes it mid-session. A two-state toggle has to guess an initial value and
 * then silently stops following the system for ever, which is worse.
 *
 * The attribute is the single source of truth for CSS:
 *   no data-theme      -> prefers-color-scheme decides
 *   data-theme=light   -> light, whatever the system says
 *   data-theme=dark    -> dark, whatever the system says
 *
 * The initial attribute is set by an inline script in index.html so it lands
 * before first paint; this component only has to stay in step with it.
 */
import { useEffect, useState } from 'react';

type Choice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'theme';

function readChoice(): Choice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system'; // private mode — behave as if nothing was ever chosen
  }
}

function apply(choice: Choice) {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* nothing persists in private mode; the page still switches */
  }
}

const NEXT: Record<Choice, Choice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const LABEL: Record<Choice, string> = {
  system: 'Theme: following your system. Switch to light.',
  light: 'Theme: light. Switch to dark.',
  dark: 'Theme: dark. Switch to following your system.',
};

const ICON: Record<Choice, string> = { system: '◐', light: '☀', dark: '☾' };

export default function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>(readChoice);

  // Keep other tabs in step — the theme is a per-reader preference, not
  // per-tab, and seeing one tab disagree with another looks like a bug.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const next = readChoice();
        setChoice(next);
        apply(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const cycle = () => {
    const next = NEXT[choice];
    setChoice(next);
    apply(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      aria-label={LABEL[choice]}
      title={LABEL[choice]}
    >
      <span aria-hidden="true">{ICON[choice]}</span>
    </button>
  );
}
