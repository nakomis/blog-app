import { DISCLOSURE_TEXT, STORE_ID } from '../utils/amazonLinks';

/**
 * The site-wide affiliate disclosure page (BAPP-16), linked from the footer.
 *
 * Posts with Amazon links also carry a one-line disclosure at the top (see
 * BlogPost.tsx); this page is the fuller explanation that line links to.
 */
export default function AffiliateDisclosure() {
  return (
    <article className="blog-post affiliate-disclosure-page">
      <header className="post-header">
        <h1>Affiliate links</h1>
      </header>
      <div className="post-content">
        <p>{DISCLOSURE_TEXT}</p>
        <p>
          Some posts link to the parts I actually used, on Amazon UK. Those links carry my
          Amazon Associates tag (<code>{STORE_ID}</code>, or a tracking id specific to the
          post), so if you buy something after following one, Amazon pays me a small
          commission. It costs you nothing extra, and you are welcome to buy the same thing
          anywhere else.
        </p>
        <p>
          A post that contains affiliate links says so at the top. The links themselves are
          marked as sponsored for search engines, and open in a new tab.
        </p>
        <p>
          The links are there because a post about hardware is more useful when you can see
          exactly which board or part it means. Nothing gets written, recommended or left out
          because of them, and nobody pays for a mention.
        </p>
        <p>
          The copy of each post sent out by email (via Substack) uses plain Amazon links
          without the tag, because affiliate links are not allowed in emails.
        </p>
      </div>
    </article>
  );
}
