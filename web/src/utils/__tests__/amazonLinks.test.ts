import { describe, expect, it } from 'vitest';
import {
  STORE_ID,
  canonicalProductUrl,
  classifyAmazonLink,
  extractAsin,
  isValidTrackingId,
  normaliseAmazonUrl,
  resolveTrackingId,
} from '../amazonLinks';

describe('extractAsin', () => {
  it.each([
    ['/diymore-ESP32-S3-CAM-Development/dp/B0F4D8ZY6L/ref=sr_1_3?keywords=x', 'B0F4D8ZY6L'],
    ['/dp/B0CRK47HXM', 'B0CRK47HXM'],
    ['/dp/b0crk47hxm/', 'B0CRK47HXM'],
    ['/gp/product/B0CRK47HXM?psc=1', 'B0CRK47HXM'],
    ['/gp/aw/d/B0CRK47HXM', 'B0CRK47HXM'],
    ['/exec/obidos/ASIN/B0CRK47HXM/whatever', 'B0CRK47HXM'],
  ])('finds the ASIN in %s', (path, asin) => {
    expect(extractAsin(path)).toBe(asin);
  });

  it.each(['/s?k=esp32', '/dp/SHORT', '/dp/B0CRK47HXMX', '/stores/page/123'])('finds none in %s', path => {
    expect(extractAsin(path)).toBeNull();
  });
});

describe('classifyAmazonLink', () => {
  it('ignores non-Amazon links', () => {
    expect(classifyAmazonLink('https://github.com/nakomis/claude-chats')).toBeNull();
    expect(classifyAmazonLink('https://notamazon.co.uk/dp/B0CRK47HXM')).toBeNull();
    expect(classifyAmazonLink('/relative/path')).toBeNull();
    expect(classifyAmazonLink('#heading')).toBeNull();
    expect(classifyAmazonLink('mailto:someone@amazon.co.uk')).toBeNull();
  });

  it('recognises UK product pages on any amazon.co.uk host', () => {
    expect(classifyAmazonLink('https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21&linkCode=ll1')).toEqual({
      kind: 'product',
      asin: 'B0F4D8ZY6L',
    });
    expect(classifyAmazonLink('http://amazon.co.uk/gp/product/B0F4D8ZY6L')).toEqual({
      kind: 'product',
      asin: 'B0F4D8ZY6L',
    });
  });

  it('recognises other UK pages', () => {
    expect(classifyAmazonLink('https://www.amazon.co.uk/s?k=esp32-s3')?.kind).toBe('uk-page');
  });

  it.each(['https://link.amazon/B00Ka0e27', 'https://amzn.to/3abcDEF', 'https://amzn.eu/d/abc', 'https://a.co/d/xyz'])(
    'treats %s as a short link',
    href => {
      expect(classifyAmazonLink(href)?.kind).toBe('short');
    },
  );

  it('flags other marketplaces', () => {
    expect(classifyAmazonLink('https://www.amazon.com/dp/B0F4D8ZY6L')).toEqual({
      kind: 'other-marketplace',
      host: 'www.amazon.com',
    });
  });
});

describe('normaliseAmazonUrl', () => {
  it('rewrites a product URL to the canonical tagged form, replacing any existing tag', () => {
    const link = classifyAmazonLink(
      'https://www.amazon.co.uk/diymore-ESP32-S3-CAM/dp/B0F4D8ZY6L/ref=sr_1_3?crid=X&tag=nakomis-21&th=1',
    )!;
    expect(normaliseAmazonUrl(link, 'nakomis-esp32-21')).toBe(
      'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-esp32-21',
    );
  });

  it('tags a non-product UK page in place', () => {
    const link = classifyAmazonLink('http://amazon.co.uk/s?k=esp32&tag=someone-else-21')!;
    expect(normaliseAmazonUrl(link, 'nakomis-esp32-21')).toBe(
      'https://www.amazon.co.uk/s?k=esp32&tag=nakomis-esp32-21',
    );
  });

  it('leaves short links and other marketplaces alone', () => {
    expect(normaliseAmazonUrl(classifyAmazonLink('https://link.amazon/B00Ka0e27')!, STORE_ID)).toBeNull();
    expect(normaliseAmazonUrl(classifyAmazonLink('https://www.amazon.com/dp/B0F4D8ZY6L')!, STORE_ID)).toBeNull();
  });

  it('builds the canonical URL', () => {
    expect(canonicalProductUrl('B0CRK47HXM', STORE_ID)).toBe('https://www.amazon.co.uk/dp/B0CRK47HXM?tag=nakomis-21');
  });
});

describe('tracking ids', () => {
  it.each(['nakomis-21', 'nakomis-esp32-21', 'n4k0-21'])('accepts %s', id => {
    expect(isValidTrackingId(id)).toBe(true);
  });

  it.each(['nakomis-20', 'nakomis', 'Nakomis-21', 'nakomis_esp32-21', '-21', 'nakomis-21 '])('rejects %j', id => {
    expect(isValidTrackingId(id)).toBe(false);
  });

  it('uses the post id when valid', () => {
    expect(resolveTrackingId('nakomis-esp32-21', true)).toEqual({
      trackingId: 'nakomis-esp32-21',
      warnings: [],
      errors: [],
    });
  });

  it('trims surrounding whitespace', () => {
    expect(resolveTrackingId(' nakomis-esp32-21 ', true).trackingId).toBe('nakomis-esp32-21');
  });

  it('falls back to the store id with a warning when links have no id', () => {
    const r = resolveTrackingId(undefined, true);
    expect(r.trackingId).toBe(STORE_ID);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/no amazon_tracking_id/);
  });

  it('says nothing when there are neither links nor an id', () => {
    expect(resolveTrackingId(undefined, false)).toEqual({ trackingId: STORE_ID, warnings: [], errors: [] });
  });

  it('errors on an id not ending -21', () => {
    const r = resolveTrackingId('nakomis-esp32-20', true);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/not a valid Amazon UK tracking id/);
  });

  it('warns about an id with no links to use it', () => {
    expect(resolveTrackingId('nakomis-esp32-21', false).warnings[0]).toMatch(/no Amazon links/);
  });
});
