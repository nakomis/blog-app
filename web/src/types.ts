export interface BlogPost {
  slug: string;
  frontmatter: {
    title: string;
    date: string;
    publish_date?: string;
    /** Set true by the review pipeline (PIPE-5) when a post is approved for
     * publication. The build only emits a post that is approved. */
    approved?: boolean;
    excerpt: string;
    tags: string[];
    author: string;
    canonical: string;
    repos?: Array<{ name: string; url: string }>;
    /** Amazon Associates tracking id for this post's links, e.g.
     * "nakomis-esp32-21" (BAPP-16). Created by hand in Associates Central. */
    amazon_tracking_id?: string;
  };
  html: string;
  /** Set by the build when the post contains Amazon Associates links; the
   * post then shows the affiliate disclosure. */
  hasAffiliateLinks?: boolean;
}

export interface BlogPostListItem {
  slug: string;
  title: string;
  publishDate: string;
  excerpt: string;
  tags: string[];
}