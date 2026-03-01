export interface BlogPost {
  slug: string;
  frontmatter: {
    title: string;
    date: string;
    excerpt: string;
    tags: string[];
    author: string;
    canonical: string;
  };
  content: string;
  html: string;
}

export interface BlogPostListItem {
  slug: string;
  title: string;
  date: string;
  excerpt: string;
  tags: string[];
}