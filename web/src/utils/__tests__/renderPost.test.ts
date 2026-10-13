import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { renderPost } from '../renderPost';
import BlogPost from '../../components/BlogPost';
import BlogFooter from '../../components/BlogFooter';
import AffiliateDisclosure from '../../components/AffiliateDisclosure';

function post(body: string, extraFrontmatter = ''): string {
  return `---
title: "Test post"
date: "2026-10-13"
excerpt: "Excerpt."
tags: ["esp32"]
author: "Martin Harris"
canonical: "https://blog.nakomis.com/2026-10-13-test"
${extraFrontmatter}---

${body}
`;
}

const FULL_URL =
  'https://www.amazon.co.uk/diymore-ESP32-S3-CAM-Development/dp/B0F4D8ZY6L/ref=sr_1_3?crid=ABC&tag=nakomis-21';

describe('renderPost: Amazon links', () => {
  it('rewrites Markdown links to the canonical URL with the post tracking id', async () => {
    const { post: p, affiliate } = await renderPost(
      post(`I used an [ESP32-S3 CAM board](${FULL_URL}).`, 'amazon_tracking_id: "nakomis-esp32-21"\n'),
      '2026-10-13-test',
    );
    expect(p.html).toContain('href="https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-esp32-21"');
    expect(p.html).toContain('rel="sponsored nofollow noopener"');
    expect(p.html).toContain('target="_blank"');
    expect(p.html).not.toContain('nakomis-21"');
    expect(p.hasAffiliateLinks).toBe(true);
    expect(affiliate).toMatchObject({
      hasAffiliateLinks: true,
      trackingId: 'nakomis-esp32-21',
      asins: ['B0F4D8ZY6L'],
      warnings: [],
      errors: [],
    });
  });

  it('rewrites raw HTML anchors and bare autolinks too', async () => {
    const { post: p, affiliate } = await renderPost(
      post(
        `<a href="https://amazon.co.uk/gp/product/B0CRK47HXM">three boards</a>\n\nOr ${FULL_URL}`,
        'amazon_tracking_id: "nakomis-esp32-21"\n',
      ),
      'slug',
    );
    expect(p.html).toContain('href="https://www.amazon.co.uk/dp/B0CRK47HXM?tag=nakomis-esp32-21"');
    expect(p.html).toContain('href="https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-esp32-21"');
    expect(affiliate.asins).toEqual(['B0CRK47HXM', 'B0F4D8ZY6L']);
  });

  it('falls back to the store id and warns when the post has no tracking id', async () => {
    const { post: p, affiliate } = await renderPost(post(`[board](${FULL_URL})`), 'slug');
    expect(p.html).toContain('href="https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21"');
    expect(affiliate.warnings).toHaveLength(1);
    expect(affiliate.errors).toEqual([]);
  });

  it('reports an invalid tracking id as an error', async () => {
    const { affiliate } = await renderPost(
      post(`[board](${FULL_URL})`, 'amazon_tracking_id: "nakomis-esp32"\n'),
      'slug',
    );
    expect(affiliate.errors[0]).toMatch(/not a valid Amazon UK tracking id/);
  });

  it('reports an unresolved short link as an error but still marks it sponsored', async () => {
    const { post: p, affiliate } = await renderPost(
      post('[board](https://link.amazon/B00Ka0e27)', 'amazon_tracking_id: "nakomis-esp32-21"\n'),
      'slug',
    );
    expect(p.html).toContain('href="https://link.amazon/B00Ka0e27"');
    expect(p.html).toContain('rel="sponsored nofollow noopener"');
    expect(affiliate.errors[0]).toMatch(/resolve-amazon-links\.py/);
  });

  it('leaves other marketplaces untagged and not marked as affiliate', async () => {
    const { post: p, affiliate } = await renderPost(post('[US](https://www.amazon.com/dp/B0F4D8ZY6L)'), 'slug');
    expect(p.html).toContain('href="https://www.amazon.com/dp/B0F4D8ZY6L"');
    expect(p.html).not.toContain('sponsored');
    expect(p.hasAffiliateLinks).toBeUndefined();
    expect(affiliate.hasAffiliateLinks).toBe(false);
    expect(affiliate.warnings[0]).toMatch(/not amazon\.co\.uk/);
  });

  it('leaves ordinary links and posts alone', async () => {
    const { post: p, affiliate } = await renderPost(post('[code](https://github.com/nakomis/claude-chats)'), 'slug');
    expect(p.html).toContain('<a href="https://github.com/nakomis/claude-chats">code</a>');
    expect(p.hasAffiliateLinks).toBeUndefined();
    expect(affiliate).toMatchObject({ hasAffiliateLinks: false, warnings: [], errors: [] });
  });

  it('does not touch Amazon URLs inside code blocks', async () => {
    const { post: p, affiliate } = await renderPost(post('```\ncurl https://link.amazon/B00Ka0e27\n```'), 'slug');
    expect(p.html).toContain('https://link.amazon/B00Ka0e27');
    expect(affiliate.hasAffiliateLinks).toBe(false);
  });
});

describe('disclosure rendering', () => {
  it('shows the disclosure on a post with affiliate links', async () => {
    const { post: p } = await renderPost(post(`[board](${FULL_URL})`, 'amazon_tracking_id: "nakomis-esp32-21"\n'), 'slug');
    const html = renderToString(createElement(BlogPost, { post: p }));
    expect(html).toContain('As an Amazon Associate I earn from qualifying purchases.');
    expect(html).toContain('href="/affiliate-disclosure"');
  });

  it('does not show it on a post without', async () => {
    const { post: p } = await renderPost(post('No links here.'), 'slug');
    const html = renderToString(createElement(BlogPost, { post: p }));
    expect(html).not.toContain('Amazon Associate');
  });

  it('links the disclosure page from the footer', () => {
    expect(renderToString(createElement(BlogFooter))).toContain('href="/affiliate-disclosure"');
  });

  it('renders the disclosure page', () => {
    const html = renderToString(createElement(AffiliateDisclosure));
    expect(html).toContain('As an Amazon Associate I earn from qualifying purchases.');
  });
});
