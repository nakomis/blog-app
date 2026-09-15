/**
 * Server entry point for prerendering (BAPP-13).
 *
 * Built separately by `vite build --ssr` and consumed by scripts/prerender.ts,
 * which is what actually writes the HTML files. Nothing in the browser imports
 * this.
 *
 * This renders the same component tree the browser does — the markup has to
 * match what React produces on the client or hydration will discard it.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { AppRoutes } from './App';
import { getBlogPosts } from './utils/contentProcessor';
import {
  BASE_URL,
  SITE_DESCRIPTION,
  SITE_TITLE,
  markdownUrl,
  postUrl,
} from './siteConfig';

export interface PrerenderRoute {
  /** Request path, e.g. `/` or `/2026-05-15-some-post`. */
  url: string;
  /** Output file relative to dist/, e.g. `index.html` or `some-post.html`. */
  outFile: string;
  title: string;
  description: string;
  canonical: string;
  /** Raw markdown alternate, for crawlers that would rather have the source. */
  markdown?: string;
  ogType: 'website' | 'article';
}

/**
 * Every route to prerender, with the head metadata each one needs.
 *
 * Derived from the same BLOG_POSTS constant the app renders from, so a post can
 * never be prerendered with metadata that disagrees with its page — or be
 * missed entirely.
 */
export function getRoutes(): PrerenderRoute[] {
  const home: PrerenderRoute = {
    url: '/',
    outFile: 'index.html',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    canonical: `${BASE_URL}/`,
    ogType: 'website',
  };

  const posts = getBlogPosts().map((post): PrerenderRoute => ({
    url: `/${post.slug}`,
    outFile: `${post.slug}.html`,
    title: `${post.frontmatter.title} | Martin Harris`,
    description: post.frontmatter.excerpt,
    canonical: post.frontmatter.canonical ?? postUrl(post.slug),
    markdown: markdownUrl(post.slug),
    ogType: 'article',
  }));

  return [home, ...posts];
}

export function render(url: string): string {
  return renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>
    </StrictMode>,
  );
}
