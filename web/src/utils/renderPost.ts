import matter from 'gray-matter';
import { applyShortcodes } from '../shortcodes';
import type { BlogPost } from '../types';
import { createMarkdownProcessor } from './markdownPipeline';
import type { AffiliateReport } from './rehypeAmazonAffiliate';

export interface RenderedPost {
  post: BlogPost;
  affiliate: AffiliateReport;
}

/**
 * Turn a post's Markdown file into the shape the app renders, plus what the
 * affiliate-link pass found in it.
 *
 * Shared by scripts/buildContent.ts (the HTML actually served) and
 * contentProcessor.ts, so the two cannot drift.
 */
export async function renderPost(markdownContent: string, slug: string): Promise<RenderedPost> {
  const { data, content } = matter(markdownContent);
  const frontmatter = data as BlogPost['frontmatter'];

  const processor = createMarkdownProcessor({ trackingId: frontmatter.amazon_tracking_id });
  const result = await processor.process(applyShortcodes(content, frontmatter, slug));

  const affiliate = result.data.affiliate as AffiliateReport;
  return {
    post: {
      slug,
      frontmatter,
      html: result.toString(),
      ...(affiliate.hasAffiliateLinks ? { hasAffiliateLinks: true } : {}),
    },
    affiliate,
  };
}
