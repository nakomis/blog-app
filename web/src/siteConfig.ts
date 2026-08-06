/**
 * Single source of truth for the site's identity.
 *
 * Previously BASE_URL existed only inside scripts/buildContent.ts, which was
 * fine while the sitemap was the only thing that needed it. Prerendering
 * (BAPP-13) needs the same value to build canonical URLs and og:url, so it
 * lives here where both the build scripts and the app can reach it.
 */
export const BASE_URL = 'https://blog.nakomis.com';

export const SITE_TITLE = 'Martin Harris - Blog | Wiring hardware to the cloud';

export const SITE_DESCRIPTION =
  'Making cloud abstractions tangible through physical hardware. ESP32, AWS, IoT, and infrastructure as code.';

/** Where the raw markdown for a post is served from. */
export const markdownUrl = (slug: string) => `${BASE_URL}/posts/${slug}.md`;

/** The canonical page URL for a post. */
export const postUrl = (slug: string) => `${BASE_URL}/${slug}`;
