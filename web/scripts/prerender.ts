/**
 * Prerender every route to a real HTML file (BAPP-13).
 *
 * Runs after both Vite builds: the client build produces dist/index.html with
 * the hashed asset links, and the SSR build produces dist-ssr/entry-server.js.
 * This script uses the first as a template and the second as the renderer.
 *
 * Why this exists: blog.nakomis.com was a client-rendered SPA, so every URL
 * returned the same ~2.3KB empty shell. Crawlers, link unfurlers and the
 * AdSense reviewer all saw a page with no content on it.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { PrerenderRoute } from '../src/entry-server.js';

const DIST = path.join(process.cwd(), 'dist');
const SSR_ENTRY = path.join(process.cwd(), 'dist-ssr', 'entry-server.js');
const TEMPLATE = path.join(DIST, 'index.html');

/** Escape for use inside a double-quoted HTML attribute. */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape for use as HTML text content. */
function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function headTags(route: PrerenderRoute): string {
  const tags = [
    `<link rel="canonical" href="${attr(route.canonical)}" />`,
    `<meta property="og:title" content="${attr(route.title)}" />`,
    `<meta property="og:description" content="${attr(route.description)}" />`,
    `<meta property="og:type" content="${route.ogType}" />`,
    `<meta property="og:url" content="${attr(route.canonical)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${attr(route.title)}" />`,
    `<meta name="twitter:description" content="${attr(route.description)}" />`,
  ];

  // Point machine readers at the markdown source. It is already served from
  // /posts/*.md and is a far cleaner representation than the rendered page.
  if (route.markdown) {
    tags.push(`<link rel="alternate" type="text/markdown" href="${attr(route.markdown)}" />`);
  }

  return tags.map(tag => `  ${tag}`).join('\n');
}

function buildPage(template: string, route: PrerenderRoute, appHtml: string): string {
  let html = template;

  // Replace rather than append: the template already carries the site-wide
  // title and description, and two of each would be ambiguous to a crawler.
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${text(route.title)}</title>`,
  );
  html = html.replace(
    /<meta\s+name="description"[\s\S]*?\/?>/,
    `<meta name="description" content="${attr(route.description)}" />`,
  );

  html = html.replace('</head>', `${headTags(route)}\n</head>`);
  html = html.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`);

  return html;
}

async function prerender() {
  if (!fs.existsSync(TEMPLATE)) {
    throw new Error(`No client build found at ${TEMPLATE} — run "vite build" first.`);
  }
  if (!fs.existsSync(SSR_ENTRY)) {
    throw new Error(`No SSR build found at ${SSR_ENTRY} — run "vite build --ssr" first.`);
  }

  const template = fs.readFileSync(TEMPLATE, 'utf-8');

  // Guard the two anchors we splice into. If a future index.html edit renames
  // or reformats them, the replace above would silently no-op and ship empty
  // pages that look like a successful build.
  if (!template.includes('<div id="root"></div>')) {
    throw new Error('index.html no longer contains <div id="root"></div> — prerender cannot inject markup.');
  }
  if (!/<meta\s+name="description"/.test(template)) {
    throw new Error('index.html no longer contains a description meta tag — prerender cannot replace it.');
  }

  const { render, getRoutes } = await import(pathToFileURL(SSR_ENTRY).href) as {
    render: (url: string) => string;
    getRoutes: () => PrerenderRoute[];
  };

  const routes = getRoutes();
  console.log(`Prerendering ${routes.length} routes...`);

  for (const route of routes) {
    const appHtml = render(route.url);
    if (!appHtml.trim()) {
      throw new Error(`${route.url} rendered to nothing — refusing to write an empty page.`);
    }
    const outPath = path.join(DIST, route.outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buildPage(template, route, appHtml));
    console.log(`✓ ${route.outFile.padEnd(60)} ${(appHtml.length / 1024).toFixed(1)}KB`);
  }

  // A dedicated 404 page, served with a real 404 status by CloudFront. The
  // distribution used to map every miss to index.html with status 200 — a soft
  // 404, which Google treats as a quality problem because every typo URL looks
  // like a valid page with thin content.
  const notFound: PrerenderRoute = {
    url: '/__not-found__',
    outFile: '404.html',
    title: 'Page not found | Martin Harris',
    description: 'That page does not exist.',
    canonical: `${routes[0].canonical}`,
    ogType: 'website',
  };
  fs.writeFileSync(
    path.join(DIST, notFound.outFile),
    buildPage(template, notFound, render(notFound.url)),
  );
  console.log(`✓ ${notFound.outFile}`);

  console.log(`\n✓ Prerendered ${routes.length + 1} pages`);
}

prerender().catch(error => {
  console.error(error);
  process.exit(1);
});
