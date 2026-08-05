/**
 * Email-capture box (PIPE-21): funnels blog readers to the Substack mirror,
 * which is the blog's newsletter — every post lands there automatically via
 * the publish pipeline.
 *
 * This used to embed Substack's own signup iframe. That iframe ships no
 * prefers-color-scheme, so it is fixed light whatever the site theme is, and
 * being cross-origin it cannot be restyled from here — a white slab on a dark
 * page (BAPP-11). Verified by running the pre-theme build locally: it has
 * always looked like that, and `?theme=dark` is ignored.
 *
 * So the form is now ours, styled with the BAPP-10 variables so it matches in
 * both modes. It posts straight to the endpoint Substack's own embed posts to:
 *
 *     <form action="/api/v1/free?nojs=true" method="post">
 *
 * `nojs=true` is Substack's no-JavaScript fallback, which matters here: a
 * native form POST is not subject to CORS, so this needs no proxy, no fetch,
 * and no API token. `email` is the only field that matters; `source` is what
 * their embed sends, and the rest of their hidden inputs are analytics hints.
 *
 * Deliberately NOT posted via fetch into a hidden iframe to keep the reader in
 * place: the response is cross-origin and unreadable, so a failed subscription
 * would look identical to a successful one. A silently broken signup form is a
 * far worse outcome than one that navigates. The submission opens Substack's
 * own confirmation page in a new tab, so the reader keeps their place on the
 * blog AND sees a real confirmation from the party that actually has to
 * deliver the email.
 */
const SUBSTACK_URL = 'https://nakomis.substack.com';

export default function SubscribeBox() {
  return (
    <aside className="subscribe-box" aria-label="Subscribe by email">
      <div className="subscribe-box__text">
        <h3>Get new posts by email</h3>
        <p>
          Every article lands in the{' '}
          <a href={SUBSTACK_URL} target="_blank" rel="noopener">
            newsletter
          </a>{' '}
          the moment it's published. Just the posts, nothing else.
        </p>
      </div>

      <form
        className="subscribe-form"
        action={`${SUBSTACK_URL}/api/v1/free?nojs=true`}
        method="post"
        target="_blank"
        rel="noopener"
      >
        {/* What Substack's own embed sends, so the signup is attributed the
            same way theirs would be. */}
        <input type="hidden" name="source" value="embed" />
        <label className="visually-hidden" htmlFor="subscribe-email">
          Email address
        </label>
        <input
          id="subscribe-email"
          className="subscribe-form__input"
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          aria-describedby="subscribe-terms"
        />
        <button className="subscribe-form__button" type="submit">
          Subscribe
        </button>
        {/* The subscription is Substack's, not ours, so the wording says so —
            their own embed says "our Privacy Policy", which reads wrong coming
            from us. All three links are the ones their embed uses, publication
            -scoped where theirs are; dropping any would be a disclosure their
            form makes and ours didn't. */}
        <p id="subscribe-terms" className="subscribe-form__terms">
          Opens Substack to confirm. By subscribing you agree to Substack&rsquo;s{' '}
          <a href={`${SUBSTACK_URL}/tos`} target="_blank" rel="noopener">
            Terms of Use
          </a>
          ,{' '}
          <a href={`${SUBSTACK_URL}/privacy`} target="_blank" rel="noopener">
            Privacy Policy
          </a>{' '}
          and{' '}
          <a
            href="https://substack.com/ccpa#personal-data-collected"
            target="_blank"
            rel="noopener"
          >
            Information collection notice
          </a>
          .
        </p>
      </form>
    </aside>
  );
}
