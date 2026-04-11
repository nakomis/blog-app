export interface BlogPost {
  slug: string;
  frontmatter: {
    title: string;
    date: string;
    publish_date?: string;
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