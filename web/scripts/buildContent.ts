import fs from 'fs';
import path from 'path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import matter from 'gray-matter';

async function processMarkdownContent(markdownContent: string, slug: string) {
  const { data: frontmatter, content } = matter(markdownContent);

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkRehype)
    .use(rehypeHighlight)
    .use(rehypeStringify);

  const result = await processor.process(content);

  return {
    slug,
    frontmatter,
    content,
    html: result.toString(),
  };
}

async function buildContent() {
  const contentDir = path.join(process.cwd(), 'content', 'blog');
  const outputPath = path.join(process.cwd(), 'src', 'content.generated.ts');

  // Check if content directory exists
  if (!fs.existsSync(contentDir)) {
    console.log('No content directory found, creating empty posts array');
    fs.writeFileSync(outputPath, 'export const BLOG_POSTS = [];\n');
    return;
  }

  // Read all markdown files
  const files = fs.readdirSync(contentDir)
    .filter(file => file.endsWith('.md'))
    .sort()
    .reverse(); // Newest first

  console.log(`Processing ${files.length} blog posts...`);

  const posts = [];

  for (const file of files) {
    const filePath = path.join(contentDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const slug = path.basename(file, '.md');

    try {
      const post = await processMarkdownContent(content, slug);
      posts.push(post);
      console.log(`✓ Processed: ${post.frontmatter.title}`);
    } catch (error) {
      console.error(`✗ Failed to process ${file}:`, error);
    }
  }

  // Generate TypeScript file
  const tsContent = `// Generated at build time - do not edit manually
export const BLOG_POSTS = ${JSON.stringify(posts, null, 2)} as const;
`;

  fs.writeFileSync(outputPath, tsContent);
  console.log(`\n✓ Generated content file with ${posts.length} posts`);
}

buildContent().catch(console.error);