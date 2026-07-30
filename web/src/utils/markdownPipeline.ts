import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';

/**
 * The single definition of how markdown becomes HTML.
 *
 * This used to be copy-pasted into both `scripts/buildContent.ts` (which runs at
 * build time and produces the HTML actually served) and
 * `src/utils/contentProcessor.ts`. Two copies meant a plugin added to one
 * silently did nothing in the other, so they live here now.
 *
 * Plugin order matters:
 *  - rehypeRaw first, so raw HTML in posts (the {{donate}} form, hand-written
 *    anchors) is parsed into real nodes before anything inspects the tree.
 *  - rehypeSlug then gives every heading a stable `id` derived from its text,
 *    which is what makes `[jump](#some-heading)` work at all.
 *  - rehypeAutolinkHeadings appends the clickable anchor. The click-to-copy
 *    behaviour is wired up in BlogPost.tsx; here we only emit the markup.
 */
export function createMarkdownProcessor(): Processor {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: 'append',
      properties: {
        className: 'heading-anchor',
        ariaLabel: 'Copy link to this section',
        title: 'Copy link to this section',
      },
      content: {
        type: 'element',
        tagName: 'span',
        properties: { ariaHidden: 'true' },
        children: [{ type: 'text', value: '#' }],
      },
    })
    .use(rehypeHighlight)
    .use(rehypeStringify) as unknown as Processor;
}
