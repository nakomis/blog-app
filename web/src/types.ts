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
  };
  html: string;
}

export interface BlogPostListItem {
  slug: string;
  title: string;
  publishDate: string;
  excerpt: string;
  tags: string[];
}