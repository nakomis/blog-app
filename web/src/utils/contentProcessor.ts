import matter from 'gray-matter';
import { createMarkdownProcessor } from './markdownPipeline';
import { BlogPost, BlogPostListItem } from '../types';
import { applyShortcodes } from '../shortcodes';
import { BLOG_POSTS } from '../content.generated';

// These are deliberately synchronous. `BLOG_POSTS` is a compile-time constant
// baked into the bundle by scripts/buildContent.ts — there is no I/O to wait
// for, and the Promises these used to return bought nothing but a "Loading..."
// frame on every navigation.
//
// Being synchronous is also what makes prerendering possible (BAPP-13): an
// effect-driven load never runs under renderToString, so the crawler would be
// served the loading state rather than the post.
export function getBlogPosts(): BlogPost[] {
  return BLOG_POSTS as unknown as BlogPost[];
}

export function getBlogPostBySlug(slug: string): BlogPost | null {
  return getBlogPosts().find(post => post.slug === slug) || null;
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