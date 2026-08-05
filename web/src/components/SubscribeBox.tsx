/**
 * Email-capture box (PIPE-21): funnels blog readers to the Substack mirror,
 * which is the blog's newsletter — every post lands there automatically via
 * the publish pipeline. Uses Substack's signup embed (an iframe, so it works
 * without any first-party form handling) with a plain link as the fallback
 * for anyone blocking third-party frames.
 *
 * Two-column layout: pitch on the left, signup form on the right; stacks on
 * narrow screens.
 */
export default function SubscribeBox() {
  return (
    <aside className="subscribe-box" aria-label="Subscribe by email">
      <div className="subscribe-box__text">
        <h3>Get new posts by email</h3>
        <p>
          Every article lands in the{' '}
          <a href="https://nakomis.substack.com" target="_blank" rel="noopener">
            newsletter
          </a>{' '}
          the moment it's published. Just the posts, nothing else.
        </p>
      </div>
      {/* The iframe is Substack's own page and is fixed light — it ships no
          prefers-color-scheme, so it cannot follow the site's theme, and being
          cross-origin it cannot be restyled from here either (BAPP-11). On a
          dark page it therefore lands as a bare white rectangle. Wrapping it in
          a padded, rounded card of the same white makes that read as an
          intentional inset panel instead of something broken. */}
      <div className="subscribe-box__embed">
        <iframe
          src="https://nakomis.substack.com/embed"
          title="Subscribe to the newsletter"
          loading="lazy"
          scrolling="no"
        />
      </div>
    </aside>
  );
}
