import matter from 'gray-matter';
import { createMarkdownProcessor } from './markdownPipeline';
import { BlogPost, BlogPostListItem } from '../types';
import { applyShortcodes } from '../shortcodes';
import { BLOG_POSTS } from '../content.generated';

export async function getBlogPosts(): Promise<BlogPost[]> {
  return BLOG_POSTS as unknown as BlogPost[];
}

export async function getBlogPostBySlug(slug: string): Promise<BlogPost | null> {
  const posts = await getBlogPosts();
  return posts.find(post => post.slug === slug) || null;
}

export function getBlogPostList(posts: BlogPost[]): BlogPostListItem[] {
  return posts
    .map(post => ({
      slug: post.slug,
      title: post.frontmatter.title,
      publishDate: post.frontmatter.publish_date ?? post.frontmatter.date,
      excerpt: post.frontmatter.excerpt,
      tags: post.frontmatter.tags,
    }))
    .sort((a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime());
}

export async function processMarkdown(markdownContent: string, slug: string): Promise<BlogPost> {
  const { data: frontmatter, content } = matter(markdownContent);

  const processor = createMarkdownProcessor();

  const result = await processor.process(applyShortcodes(content, frontmatter as BlogPost['frontmatter'], slug));

  return {
    slug,
    frontmatter: frontmatter as BlogPost['frontmatter'],
    html: result.toString(),
  };
}