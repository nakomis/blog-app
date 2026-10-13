import type { Element, Root, RootContent } from 'hast';
import {
  type AmazonLink,
  classifyAmazonLink,
  normaliseAmazonUrl,
  resolveTrackingId,
} from './amazonLinks';

/** What the plugin found in a post, left on `file.data.affiliate` for the build. */
export interface AffiliateReport {
  /** True if the post contains at least one Associates link (it needs the disclosure). */
  hasAffiliateLinks: boolean;
  /** The tag every rewritten link carries. */
  trackingId: string;
  /** Distinct ASINs linked, in order of first appearance. */
  asins: string[];
  /** Missed earnings or attribution: worth a look, never fatal. */
  warnings: string[];
  /** Problems that must not reach the live site. The build fails on these for live posts. */
  errors: string[];
}

/** The slice of a vfile the plugin touches (vfile is not a direct dependency). */
interface FileWithData {
  data: { affiliate?: AffiliateReport } & Record<string, unknown>;
}

export interface RehypeAmazonAffiliateOptions {
  /** The post's `amazon_tracking_id` frontmatter, unvalidated. */
  trackingId?: unknown;
}

/** rel tokens Google asks for on paid links, plus noopener for target=_blank. */
export const AFFILIATE_REL = ['sponsored', 'nofollow', 'noopener'];

function collectAnchors(node: Root | RootContent, out: Element[]): void {
  if (node.type === 'element' && node.tagName === 'a') out.push(node);
  if ('children' in node) {
    for (const child of node.children) collectAnchors(child, out);
  }
}

/**
 * Rewrite Amazon links to the canonical tagged form and mark them as paid links.
 *
 * Runs after rehype-raw, so links written as raw HTML are caught as well as
 * Markdown ones. Leaves its findings on `file.data.affiliate`; the build decides
 * whether a finding is fatal (it is for a post about to go live).
 */
export default function rehypeAmazonAffiliate(options: RehypeAmazonAffiliateOptions = {}) {
  return (tree: Root, file: FileWithData) => {
    const anchors: Element[] = [];
    collectAnchors(tree, anchors);

    const amazon: Array<{ el: Element; href: string; link: AmazonLink }> = [];
    for (const el of anchors) {
      const href = el.properties?.href;
      if (typeof href !== 'string') continue;
      const link = classifyAmazonLink(href);
      if (link) amazon.push({ el, href, link });
    }

    const affiliate = amazon.filter(a => a.link.kind !== 'other-marketplace');
    const { trackingId, warnings, errors } = resolveTrackingId(
      options.trackingId,
      affiliate.length > 0,
    );
    const asins: string[] = [];

    for (const { el, href, link } of amazon) {
      if (link.kind === 'other-marketplace') {
        warnings.push(`${href} is on ${link.host}, not amazon.co.uk; it earns nothing and is left as written.`);
        continue;
      }
      if (link.kind === 'short') {
        errors.push(
          `${href} is a short link, which the build cannot rewrite or check. ` +
            'Resolve it with blog-content/scripts/resolve-amazon-links.py.',
        );
      }
      if (link.kind === 'product' && !asins.includes(link.asin)) asins.push(link.asin);

      const normalised = normaliseAmazonUrl(link, trackingId);
      el.properties = {
        ...el.properties,
        href: normalised ?? href,
        rel: AFFILIATE_REL,
        target: '_blank',
      };
    }

    file.data.affiliate = {
      hasAffiliateLinks: affiliate.length > 0,
      trackingId,
      asins,
      warnings,
      errors,
    };
  };
}
