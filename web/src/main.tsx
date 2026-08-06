import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import App from './App.tsx';

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

const container = document.getElementById('root')!;

// Prerendered pages (BAPP-13) arrive with markup already in #root, so hydrate
// rather than re-render — re-rendering would throw the server's HTML away and
// repaint, which is both slower and visible.
//
// `vite dev` serves the unmodified index.html with an empty #root, so fall back
// to a client render there. Hydrating an empty container "works" but logs a
// mismatch on every dev page load.
if (container.hasChildNodes()) {
  hydrateRoot(container, app);
} else {
  createRoot(container).render(app);
}
