import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings, { type Options as AutolinkOptions } from 'rehype-autolink-headings';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import type { Element } from 'hast';

/**
 * The '#' appended to each heading. Wrapped in a span marked aria-hidden so the
 * link is announced by its aria-label rather than as the character "#".
 */
const ANCHOR_CONTENT: Element = {
  type: 'element',
  tagName: 'span',
  properties: { ariaHidden: 'true' },
  children: [{ type: 'text', value: '#' }],
};

// Typed explicitly rather than inline: TypeScript loses the plugin's option
// type partway along a long .use() chain and starts matching a neighbouring
// plugin's signature instead.
const AUTOLINK_OPTIONS: AutolinkOptions = {
  behavior: 'append',
  properties: {
    // hast models class as a list of tokens, not a single string.
    className: ['heading-anchor'],
    ariaLabel: 'Copy link to this section',
    title: 'Copy link to this section',
  },
  content: ANCHOR_CONTENT,
};

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
export function createMarkdownProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, AUTOLINK_OPTIONS)
    .use(rehypeHighlight)
    .use(rehypeStringify);
}
