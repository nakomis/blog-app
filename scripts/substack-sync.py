#!/usr/bin/env python3
"""
Mirror newly-published blog posts to nakomis.substack.com (PIPE-11).

Runs as the final step of the scheduled-publish workflow, after the site has
deployed. It compares the set of live posts (approved AND publish_date arrived
— the same gate as buildContent.ts / ingest-blog.py) against the publication's
public archive, and publishes anything missing via the Substack API
(python-substack).

Substack behaviours this leans on, learnt during the 2026-07-22 manual
migration:

  - Password login is captcha-gated, so auth is a session cookie stored in SSM
    (`/blog/prod/substack/session`). When it expires this script fails loudly
    with instructions; refresh by copying `substack.sid` from a logged-in
    browser back into the parameter.
  - External image URLs must not be used in post bodies: readers load them from
    substack.com, so the blog's hotlink protection serves them the pirate
    image. Local image paths are uploaded to Substack's own media store by the
    markdown renderer; this script verifies none slipped through.
  - Slugs are date-prefixed to match blog canonical paths. The pre-migration
    certificate post kept a legacy truncated slug, so existing-post matching
    falls back to normalised title comparison.

Email rules: new posts notify subscribers (send=true) EXCEPT the slugs in
NO_EMAIL_SLUGS (the six 2026-07 backfill posts — web-only by decision). As a
storm guard, the run fails outright if more than MAX_SENDS_PER_RUN posts would
email: at the pipeline's cadence that many new posts at once means something is
wrong, and no email goes out until a human looks.
"""
import argparse
import datetime
import json
import os
import re
import sys
import time

import boto3
import requests

PUBLICATION_URL = os.environ.get("SUBSTACK_PUBLICATION_URL", "https://nakomis.substack.com")
SESSION_PARAM = os.environ.get("SUBSTACK_SESSION_PARAM", "/blog/prod/substack/session")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-2")

MAX_SENDS_PER_RUN = 2

# The 2026-07 backfill: mirrored without emailing subscribers (Martin's call —
# they had been live on the blog for weeks by the time the mirror caught up).
NO_EMAIL_SLUGS = {
    "2026-04-13-pi5-nas-five-failure-modes",
    "2026-04-25-private-cargo-registry-codeartifact",
    "2026-04-29-meta-mcp",
    "2026-05-15-ditched-slint-for-egui-thermostat-dial",
    "2026-05-15-three-tickets-one-filesystem",
    "2026-06-03-why-i-switched-to-pnpm",
}

FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-(.+)\.md$")
# {{image}} is a generation directive for the review pipeline and means nothing
# on the mirror, so it is removed. {{donate}} used to be removed too, which left
# Substack readers with no way to contribute at all — it is now substituted, see
# DONATE_MD below.
PLACEHOLDER_RE = re.compile(r"^\s*\{\{image\b[^}]*\}\}\s*$", re.M)
DONATE_PLACEHOLDER_RE = re.compile(r"^\s*\{\{donate\}\}\s*$", re.M)
LEADING_H1_RE = re.compile(r"^\s*#\s+.+\n+", flags=0)

# Substack supports in-page section links, but prefixes the fragment with a
# section sign. Its own "copy link to section" produces /i/<post_id>/<slug>,
# which 301s to:
#     /p/<post-slug>?open=false#%C2%A7<slug>
# i.e. the fragment is "§<slug>". Headings carry no id attribute — the jump is
# resolved client-side from that prefixed fragment.
#
# Usefully, Substack's slugs match rehype-slug's (github-slugger) output:
#   "The Cabal"                    -> the-cabal
#   "Seven models, four winners"   -> seven-models-four-winners
#   "The bit I wasn't looking for" -> the-bit-i-wasnt-looking-for
#
# So an in-document link needs only the prefix adding. Verified 2026-07-30
# against the live mirror. See BAPP-7.
SECTION_SIGN = "§"
INDOC_LINK_RE = re.compile(r"(\[[^\]]+\]\()#(?!" + SECTION_SIGN + r")([^)]+)\)")

# Hand-written <a id="..."></a> anchors cannot work on Substack: there are no
# heading ids to begin with, and the jump is driven by the heading text slug.
# Drop them. Posts should link to the heading's own slug instead, which
# rehype-slug generates on the blog side.
BARE_ANCHOR_RE = re.compile(r'<a\s+id="[^"]*"\s*>\s*</a>\s*\n?', re.I)

# Substack has no native donation feature; the documented workaround is a link
# to an external payment URL. PayPal hosts the button image itself, so this
# needs no hosting of ours — and crucially avoids blog.nakomis.com's hotlink
# protection, which would serve the pirate image to Substack readers.
DONATE_MD = (
    "[![Donate with PayPal]"
    "(https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)]"
    "(https://www.paypal.com/donate/?hosted_button_id=Q3BESC73EWVNN)"
)


# --- Substack renderer limitations (BAPP-8) -------------------------------
#
# Two things the blog does that Substack cannot, worked around by rewriting the
# markdown before it ever reaches python-substack. Both were verified against
# the live mirror on 2026-07-30 rather than assumed:
#
# 1. TABLES. python-substack builds its parser with MarkdownIt("commonmark")
#    and never enables the table rule, so table lines are never tokenised as a
#    table — they fall through to the paragraph renderer and arrive as one run
#    of literal pipe text with the row breaks gone. This is not a preset we can
#    flip: nodes.py has no table node type at all, so the library has no way to
#    express one. We flatten tables to bullets instead, which loses the grid but
#    keeps every cell and its column label.
#
# 2. CODE BLOCK LANGUAGES. mdrender does pass language through correctly
#    (attrs: {"language": "bash"}), and the value survives all the way into the
#    POSTed draft body — Substack discards it. Every <pre><code> across every
#    mirrored post is bare, with no class or data attribute. Substack has no
#    syntax highlighting to drive, so there is nothing to fix on our side; we
#    label the block with a caption line instead so the reader still knows what
#    they are looking at.
FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})\s*(\S*)")
TABLE_DELIM_RE = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$")

# Pretty labels for the languages actually used across the blog. Anything not
# listed is title-cased, so a new language degrades to a sensible label rather
# than to nothing.
LANG_LABELS = {
    "bash": "Bash", "sh": "Shell", "shell": "Shell", "zsh": "Zsh",
    "python": "Python", "py": "Python", "ts": "TypeScript",
    "typescript": "TypeScript", "js": "JavaScript", "javascript": "JavaScript",
    "json": "JSON", "yaml": "YAML", "yml": "YAML", "toml": "TOML",
    "sql": "SQL", "rust": "Rust", "rs": "Rust", "go": "Go", "c": "C",
    "cpp": "C++", "java": "Java", "html": "HTML", "css": "CSS",
    "diff": "Diff", "ini": "INI", "dockerfile": "Dockerfile",
    "mermaid": "Mermaid", "hcl": "HCL", "xml": "XML", "swift": "Swift",
}
# Languages worth no caption: they say nothing a reader cannot already see.
UNLABELLED_LANGS = {"", "text", "plain", "plaintext", "txt", "console", "output"}


def _split_row(line: str) -> list[str]:
    """Cells of a markdown table row, honouring \\| escapes inside cells."""
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells, buf, i = [], "", 0
    while i < len(line):
        if line[i] == "\\" and i + 1 < len(line) and line[i + 1] == "|":
            buf += "|"      # an escaped pipe is content, not a separator
            i += 2
            continue
        if line[i] == "|":
            cells.append(buf.strip())
            buf = ""
        else:
            buf += line[i]
        i += 1
    cells.append(buf.strip())
    return cells


def _table_to_bullets(header: list[str], rows: list[list[str]]) -> list[str]:
    """Render a table as one bullet per row, first cell as the row's label.

    Two-column tables are the common term/definition case and read better
    without repeating the second column's header on every line.
    """
    out = []
    for row in rows:
        row = row + [""] * (len(header) - len(row))    # tolerate short rows
        label = row[0] or "—"
        rest = [
            (f"{header[i]}: {row[i]}" if len(header) > 2 else row[i])
            for i in range(1, len(header))
            if row[i]
        ]
        out.append(f"- **{label}**" + (f" — {'; '.join(rest)}" if rest else ""))
    return out


def rewrite_for_substack(md: str) -> str:
    """Flatten tables and caption code blocks, skipping fenced content.

    Fence tracking matters in both directions: a pipe-delimited line inside a
    shell snippet must not be mistaken for a table, and a fence's own info
    string must only be read when the fence opens.
    """
    lines = md.split("\n")
    out: list[str] = []
    fence: str | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        m = FENCE_RE.match(line)
        if m and (fence is None or line.strip().startswith(fence)):
            if fence is None:
                fence = m.group(2)
                lang = m.group(3).strip().lower()
                if lang not in UNLABELLED_LANGS:
                    label = LANG_LABELS.get(lang, lang.title())
                    # Blank line before, or Substack glues the caption to the
                    # preceding paragraph.
                    if out and out[-1].strip():
                        out.append("")
                    out.append(f"**{label}**")
                    out.append("")
            else:
                fence = None
            out.append(line)
            i += 1
            continue

        if fence is None and line.lstrip().startswith("|") \
                and i + 1 < len(lines) and TABLE_DELIM_RE.match(lines[i + 1]):
            header = _split_row(line)
            i += 2
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(_split_row(lines[i]))
                i += 1
            out.extend(_table_to_bullets(header, rows))
            continue

        out.append(line)
        i += 1
    return "\n".join(out)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Return ({key: value}, body) from simple `key: "value"` frontmatter."""
    if not text.startswith("---\n"):
        return ({}, text)
    end = text.find("\n---", 4)
    if end == -1:
        return ({}, text)
    fm = {}
    for line in text[4:end].splitlines():
        m = re.match(r'^(\w+):\s*(.+?)\s*$', line)
        if m:
            fm[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return (fm, text[end + 4:].lstrip("\n"))


def norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", title.lower())


def live_posts(content_dir: str) -> list[dict]:
    """Every post that is live on the blog, oldest publish_date first."""
    posts = []
    today = datetime.date.today().isoformat()
    for name in sorted(os.listdir(content_dir)):
        m = FILE_RE.match(name)
        if not m:
            continue
        path = os.path.join(content_dir, name)
        with open(path, encoding="utf-8") as fh:
            fm, body = parse_frontmatter(fh.read())
        approved = str(fm.get("approved", "")).strip().lower() == "true"
        publish_date = fm.get("publish_date") or fm.get("date", "")
        if not approved or not publish_date or publish_date > today:
            continue
        posts.append({
            "slug": name[:-3],
            "path": path,
            "title": fm.get("title", name[:-3]),
            "excerpt": fm.get("excerpt", ""),
            "publish_date": publish_date,
            "body": body,
        })
    posts.sort(key=lambda p: p["publish_date"])
    return posts


def substack_archive() -> list[dict]:
    """Posts on the publication via the PUBLIC archive API.

    CDN-cached and can lag several minutes behind reality — fine for dry runs,
    NOT safe as the idempotency check before publishing (learnt the hard way:
    a stale archive re-published five posts' worth of duplicates as drafts).
    """
    out, offset = [], 0
    while True:
        r = requests.get(
            f"{PUBLICATION_URL}/api/v1/archive",
            params={"sort": "new", "limit": 50, "offset": offset},
            timeout=30,
        )
        r.raise_for_status()
        page = r.json()
        if not page:
            return out
        out.extend({"slug": p["slug"], "title": p.get("title", "")} for p in page)
        offset += len(page)


def published_posts(api) -> list[dict]:
    """Posts on the publication via the authenticated API — never cached."""
    out, offset, limit = [], 0, 25
    while True:
        page = api.get_published_posts(offset=offset, limit=limit)
        items = page if isinstance(page, list) else page.get("posts", [])
        out.extend({"slug": p["slug"], "title": p.get("title", "")} for p in items)
        if len(items) < limit:
            return out
        offset += len(items)


def subtitle_for(excerpt: str, limit: int = 140) -> str:
    """Substack rejects long subtitles; cut at a word boundary under the limit."""
    if len(excerpt) <= limit:
        return excerpt
    return excerpt[:limit - 1].rsplit(" ", 1)[0] + "…"


def prepare_markdown(post: dict) -> str:
    """Adapt a blog post's markdown for Substack.

    Strips {{image}} directives and the leading H1 (Substack renders its own
    title), substitutes {{donate}} for a PayPal link, drops hand-written
    anchors, and prefixes in-document links with the section sign Substack
    expects. See BAPP-7.

    Finally flattens tables and captions code blocks, neither of which Substack
    can render as the blog does. See BAPP-8 and rewrite_for_substack.
    """
    md = PLACEHOLDER_RE.sub("", post["body"])
    md = DONATE_PLACEHOLDER_RE.sub(DONATE_MD, md)
    md = LEADING_H1_RE.sub("", md, count=1)
    md = BARE_ANCHOR_RE.sub("", md)
    md = INDOC_LINK_RE.sub(r"\1#" + SECTION_SIGN + r"\2)", md)
    # Last: it is fence-aware, so it must run after the substitutions above
    # rather than race them for the same lines.
    md = rewrite_for_substack(md)
    return md.strip() + "\n"


def load_session_cookie() -> str:
    ssm = boto3.client("ssm", region_name=AWS_REGION)
    try:
        value = ssm.get_parameter(Name=SESSION_PARAM, WithDecryption=True)["Parameter"]["Value"]
    except ssm.exceptions.ParameterNotFound:
        sys.exit(
            f"error: SSM parameter {SESSION_PARAM} not found. Store the substack.sid "
            "session cookie there (SecureString) — see the script docstring."
        )
    value = value.strip()
    return value if "=" in value else f"substack.sid={value}"


def connect(cookie: str):
    from substack import Api
    from substack.exceptions import SubstackAPIException

    try:
        return Api(cookies_string=cookie, publication_url=PUBLICATION_URL)
    except SubstackAPIException as err:
        if "challenge" in str(err) or "Just a moment" in str(err):
            sys.exit(
                "error: Substack's Cloudflare bot challenge blocked this request. "
                "The session cookie is probably fine — this happens from datacentre "
                "IPs (e.g. GitHub-hosted runners) regardless of auth. Run the sync "
                "from a residential IP (locally or a self-hosted runner)."
            )
        sys.exit(
            f"error: Substack session rejected ({err}). The cookie in {SESSION_PARAM} "
            "has likely expired — copy a fresh substack.sid value from a logged-in "
            "browser (DevTools → Application → Cookies → substack.com) into the "
            "parameter and re-run."
        )


def draft_has_local_images(draft: dict) -> bool:
    """True if any image src in the draft body is not an uploaded https URL."""
    body = draft.get("draft_body", "")
    if isinstance(body, dict):
        body = json.dumps(body)
    return bool(re.search(r'"src":\s*"(?!https://)', body))


def publish_post(api, post: dict, send: bool, dry_run: bool) -> None:
    action = "email" if send else "web-only"
    if dry_run:
        print(f"DRY RUN: would publish {post['slug']} ({action})")
        return

    result = api.create_draft_from_markdown(
        title=post["title"],
        markdown=prepare_markdown(post),
        subtitle=subtitle_for(post["excerpt"]),
        slug=post["slug"],
        search_engine_description=post["excerpt"][:300] or None,
        publish=False,
    )
    draft = result["draft"]
    draft_id = draft["id"]

    if draft_has_local_images(draft):
        api.delete_draft(draft_id)
        sys.exit(f"error: {post['slug']} draft contains un-uploaded image paths; aborting")

    api.prepublish_draft(draft_id)
    api.publish_draft(draft_id, send=send, share_automatically=False)

    # Substack only allows changing post_date on a published post, and the
    # change needs a re-publish (send=False → no email) to take effect. Only
    # bother when the blog date isn't today, i.e. for backfilled history.
    if post["publish_date"] != datetime.date.today().isoformat():
        try:
            api.put_draft(draft_id, post_date=f"{post['publish_date']}T08:00:00.000Z")
            api.publish_draft(draft_id, send=False, share_automatically=False)
        except Exception as err:  # noqa: BLE001 — cosmetic; never block publication
            print(f"warn: could not set post_date on {post['slug']}: {err}", file=sys.stderr)

    print(f"published: {post['slug']} ({action})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-dir", default="web/content/blog")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # Relative image paths in the markdown resolve against the content dir; the
    # renderer uploads them to Substack's media store from the CWD.
    os.chdir(args.content_dir)

    live = live_posts(".")
    api = None
    if args.dry_run:
        existing = substack_archive()
    else:
        api = connect(load_session_cookie())
        existing = published_posts(api)
    existing_slugs = {p["slug"] for p in existing}
    existing_titles = {norm_title(p["title"]) for p in existing}

    missing = [
        p for p in live
        if p["slug"] not in existing_slugs and norm_title(p["title"]) not in existing_titles
    ]
    print(f"{len(live)} live post(s), {len(existing)} on Substack, {len(missing)} to mirror")
    if not missing:
        return

    sends = [p for p in missing if p["slug"] not in NO_EMAIL_SLUGS]
    if len(sends) > MAX_SENDS_PER_RUN:
        sys.exit(
            f"error: {len(sends)} posts would email subscribers (cap {MAX_SENDS_PER_RUN}). "
            "That many at once means something is wrong — refusing to publish any. "
            f"Would-be sends: {[p['slug'] for p in sends]}"
        )

    for i, post in enumerate(missing):
        if i and not args.dry_run:
            time.sleep(15)  # image uploads + draft creation trip Substack's rate limit
        publish_post(api, post, send=post["slug"] not in NO_EMAIL_SLUGS, dry_run=args.dry_run)

    if not args.dry_run:
        # Belt and braces: confirm everything we just published is really there.
        after = {p["slug"] for p in published_posts(api)}
        failed = [p["slug"] for p in missing if p["slug"] not in after]
        if failed:
            sys.exit(f"error: published but not visible in published list: {failed}")
        print("Substack mirror in sync.")


if __name__ == "__main__":
    main()
