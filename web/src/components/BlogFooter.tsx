import { AFFILIATE_DISCLOSURE_PATH } from '../siteConfig';

export default function BlogFooter() {
  return (
    <footer className="blog-footer">
      <p>
        <a href="https://github.com/nakomis/blog-app" target="_blank" rel="noopener">
          Website code
        </a>{' '}
        licensed under CC0.
        Blog content ©2026 Martin Harris. All rights reserved.{' '}
        <a href={AFFILIATE_DISCLOSURE_PATH}>Affiliate links</a>.
      </p>
      <p>
        <em>"Ceci n'est pas une API Gateway"</em> — Making cloud abstractions tangible through physical hardware.
      </p>
    </footer>
  );
}
