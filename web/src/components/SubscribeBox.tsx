/**
 * Email-capture box (PIPE-21): funnels blog readers to the Substack mirror,
 * which is the blog's newsletter — every post lands there automatically via
 * the publish pipeline. Uses Substack's signup embed (an iframe, so it works
 * without any first-party form handling) with a plain link as the fallback
 * for anyone blocking third-party frames.
 */
export default function SubscribeBox() {
  return (
    <aside className="subscribe-box" aria-label="Subscribe by email">
      <h3>Get new posts by email</h3>
      <p>
        Every article lands in the{' '}
        <a href="https://nakomis.substack.com" target="_blank" rel="noopener">
          newsletter
        </a>{' '}
        the moment it's published — no algorithms, no noise.
      </p>
      <iframe
        src="https://nakomis.substack.com/embed"
        title="Subscribe to the newsletter"
        loading="lazy"
        scrolling="no"
      />
    </aside>
  );
}
