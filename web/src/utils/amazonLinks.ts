/**
 * Amazon Associates links (BAPP-16).
 *
 * Authors paste whatever Amazon gives them — a full product URL copied from the
 * address bar, or a SiteStripe link — and the build rewrites every amazon.co.uk
 * link in the post to one canonical form:
 *
 *     https://www.amazon.co.uk/dp/<ASIN>?tag=<tracking id>
 *
 * The tracking id comes from the post's `amazon_tracking_id` frontmatter, so
 * Associates Central can attribute earnings to the post. Tracking ids are
 * created by hand in Associates Central (there is no API); a post with Amazon
 * links but no id of its own falls back to the store id with a warning.
 *
 * SiteStripe short links (`link.amazon/...`, `amzn.to/...`) are opaque: the
 * build cannot see the product or change the tag inside them, so they are
 * resolved once at authoring time by blog-content's
 * `scripts/resolve-amazon-links.py`, which rewrites them to the /dp/ form.
 */

/** The Associates store id: the fallback tag, and the account's default. */
export const STORE_ID = 'nakomis-21';

/** The marketplace the store belongs to. Links elsewhere earn nothing. */
export const MARKETPLACE_HOST = 'www.amazon.co.uk';

export const DISCLOSURE_TEXT = 'As an Amazon Associate I earn from qualifying purchases.';

/** Amazon UK tracking ids: lowercase letters, digits and hyphens, ending -21. */
const TRACKING_ID_RE = /^[a-z0-9][a-z0-9-]*-21$/;

const ASIN_RE = /^[A-Z0-9]{10}$/;

/** Path shapes that carry an ASIN, e.g. /Some-Title/dp/B0F4D8ZY6L/ref=... */
const ASIN_PATH_RES = [
  /\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/gp\/product\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/o\/ASIN\/([A-Z0-9]{10})(?:[/?#]|$)/i,
];

/** Redirecting short-link hosts. Their target is invisible to the build. */
const SHORT_LINK_HOSTS = new Set(['link.amazon', 'amzn.to', 'amzn.eu', 'a.co']);

export type AmazonLink =
  /** An amazon.co.uk product page; rewritten to the canonical /dp/ URL. */
  | { kind: 'product'; asin: string }
  /** Some other amazon.co.uk page (search, store front); keeps its path, gains the tag. */
  | { kind: 'uk-page'; url: URL }
  /** A short link: cannot be rewritten, must be resolved at authoring time. */
  | { kind: 'short'; host: string }
  /** Another marketplace (amazon.com, amazon.de...): a UK tag earns nothing there. */
  | { kind: 'other-marketplace'; host: string };

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

function isAmazonHost(host: string): boolean {
  // amazon.co.uk, www.amazon.co.uk, smile.amazon.com, amazon.de...
  return /(^|\.)amazon\.[a-z.]+$/.test(host);
}

/** Pull the ASIN out of a product URL path, if it has one. */
export function extractAsin(pathname: string): string | null {
  for (const re of ASIN_PATH_RES) {
    const m = re.exec(pathname);
    if (m) {
      const asin = m[1].toUpperCase();
      if (ASIN_RE.test(asin)) return asin;
    }
  }
  return null;
}

/** Classify a link target, or return null if it is not an Amazon link at all. */
export function classifyAmazonLink(href: string): AmazonLink | null {
  const url = parse(href);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  const host = url.hostname.toLowerCase();

  if (SHORT_LINK_HOSTS.has(host)) return { kind: 'short', host };
  if (!isAmazonHost(host)) return null;
  if (host !== 'amazon.co.uk' && !host.endsWith('.amazon.co.uk')) {
    return { kind: 'other-marketplace', host };
  }

  const asin = extractAsin(url.pathname);
  return asin ? { kind: 'product', asin } : { kind: 'uk-page', url };
}

/** The canonical tagged URL for a product. */
export function canonicalProductUrl(asin: string, trackingId: string): string {
  return `https://${MARKETPLACE_HOST}/dp/${asin}?tag=${encodeURIComponent(trackingId)}`;
}

/**
 * The URL a link should be rendered with, or null if it cannot be rewritten
 * (short links and other marketplaces are left exactly as written).
 */
export function normaliseAmazonUrl(link: AmazonLink, trackingId: string): string | null {
  switch (link.kind) {
    case 'product':
      return canonicalProductUrl(link.asin, trackingId);
    case 'uk-page': {
      const url = new URL(link.url.href);
      url.protocol = 'https:';
      url.hostname = MARKETPLACE_HOST;
      url.searchParams.set('tag', trackingId);
      return url.href;
    }
    default:
      return null;
  }
}

export function isValidTrackingId(id: string): boolean {
  return TRACKING_ID_RE.test(id);
}

export interface TrackingIdResolution {
  trackingId: string;
  warnings: string[];
  errors: string[];
}

/**
 * Decide which tag a post's links get.
 *
 * - No id and no links: nothing to say.
 * - Links but no id: fall back to the store id, and warn — the earnings will
 *   land in the account but not be attributable to the post.
 * - An id that does not look like an Amazon UK tracking id: error. It would
 *   silently earn nothing, which is worse than failing the build.
 */
export function resolveTrackingId(raw: unknown, hasAffiliateLinks: boolean): TrackingIdResolution {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (raw === undefined || raw === null || raw === '') {
    if (hasAffiliateLinks) {
      warnings.push(
        `has Amazon links but no amazon_tracking_id; falling back to the store id ${STORE_ID}. ` +
          'Ask Martin to create a tracking id for this post in Associates Central.',
      );
    }
    return { trackingId: STORE_ID, warnings, errors };
  }

  const id = String(raw).trim();
  if (!isValidTrackingId(id)) {
    errors.push(
      `amazon_tracking_id "${id}" is not a valid Amazon UK tracking id ` +
        '(lowercase letters, digits and hyphens, ending in -21).',
    );
    return { trackingId: STORE_ID, warnings, errors };
  }
  if (!hasAffiliateLinks) {
    warnings.push(`amazon_tracking_id "${id}" is set but the post has no Amazon links.`);
  }
  return { trackingId: id, warnings, errors };
}
