#!/usr/bin/env python3
"""
Announce newly published blog posts on Bluesky (PIPE-20).

Runs after the Substack mirror in the scheduled-publish `substack` job. Finds
live blog posts (same approved+date gate as everywhere else) that went live on
or after CUTOFF_DATE, and announces the oldest one not already on the profile —
linking the Substack copy, since growing that audience is the point (PIPE-19).

Deliberately quiet by design:

  - Posts published before CUTOFF_DATE are never announced — the existing
    archive stays off the profile.
  - At most ONE announcement per run.
  - Announcements follow publication: a post is announced on the run where it
    goes live. The publication queue's own 3-day cadence provides the spacing;
    MIN_GAP_HOURS is only a flood guard so a burst of same-day publishes
    drains at one announcement per day instead of all at once.
  - Nothing is posted if the profile's latest post-announcing entry (manual or
    automated — both count) is under MIN_GAP_HOURS old — unless the next
    pending post is marked `bluesky_announce: force` in its frontmatter
    (the bag's "Force Announce" option, PIPE-29), which bypasses the guard.
  - Idempotent by URL: the profile's own feed is the record of what has been
    announced; anything linking a post's Substack URL suppresses it forever.

Auth is an app password, from `BLUESKY_HANDLE`/`BLUESKY_APP_PASSWORD` if both are
set, otherwise SSM (`/blog/prod/bluesky/credentials`, JSON `{"handle": ...,
"app_password": ...}`).

Three modes (PIPE-32):

  (no flag)  Everything in one pass, teaser from Bedrock. This is the original
             behaviour and the rollback path — do not let it rot.
  --select   Guards only, on the GitHub runner: pick a post, apply the flood
             guard and feed idempotency, and print a payload for the Claude Code
             Routine to fire with. Prints nothing when there is nothing to say.
  --post     Posting only, inside the Routine's container: take a model-written
             teaser, put it through the URL guard, re-check idempotency, post.

The split exists because `POST /fire` does not return the Routine's output — it
is fire-and-forget — so the Routine has to do the posting itself. Everything that
must not be left to a model's judgement stays in this file on both sides of that
fence: the model writes one string, and `--post` decides whether it ships.
"""
import argparse
import datetime
import json
import os
import re
import sys

import requests

# boto3 is imported lazily: the Routine's container installs only atproto and
# requests, and never reaches the SSM or Bedrock code paths.

CREDS_PARAM = os.environ.get("BLUESKY_CREDS_PARAM", "/blog/prod/bluesky/credentials")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-2")
SUBSTACK_URL = "https://nakomis.substack.com"

CUTOFF_DATE = "2026-07-29"
# Flood guard only — NOT the announcement cadence. Publication dates drive
# when posts are announced; this just stops a multi-post day flooding the
# feed. Under 24h so the once-a-day scheduled run is never blocked by the
# previous day's announcement.
MIN_GAP_HOURS = 20
MAX_POST_CHARS = 300
# How much of the article the teaser writer sees. Same budget the Bedrock prompt
# has always used; the /fire payload allows 65,536 chars if that ever needs to grow.
BODY_CHARS = 6000
# Separates the metadata line from the article in the /fire payload.
ARTICLE_MARKER = "---article---"

FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-(.+)\.md$")


def parse_frontmatter(text: str) -> dict:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    fm = {}
    for line in text[4:end].splitlines():
        m = re.match(r'^(\w+):\s*(.+?)\s*$', line)
        if m:
            fm[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return fm


def strip_frontmatter(raw: str) -> str:
    """The article, minus its YAML frontmatter.

    Not `raw.split("\\n---", 2)[-1]`, which is what this used to be. Posts end
    with a `---` rule above the bio footer, so that returned the ~180-character
    footer — bio line and `{{donate}}` — instead of the article. Three of the
    four live posts were being teased from that footer alone.

    (Not the cause of the 4 Aug 2026 hallucinated URL: that post happened to
    split favourably and the model did see its article. The URL guard is still
    the thing that stops a repeat.)
    """
    if not raw.startswith("---\n"):
        return raw
    close = raw.find("\n---", 4)
    if close == -1:
        return raw
    end_of_line = raw.find("\n", close + 4)
    return raw[end_of_line + 1:] if end_of_line != -1 else ""


def candidate_posts(content_dir: str) -> list[dict]:
    """Live posts published on/after the cutoff, oldest first."""
    today = datetime.date.today().isoformat()
    posts = []
    for name in sorted(os.listdir(content_dir)):
        m = FILE_RE.match(name)
        if not m:
            continue
        with open(os.path.join(content_dir, name), encoding="utf-8") as fh:
            raw = fh.read()
        fm = parse_frontmatter(raw)
        approved = str(fm.get("approved", "")).strip().lower() == "true"
        publish_date = fm.get("publish_date") or fm.get("date", "")
        if not approved or not publish_date or publish_date > today:
            continue
        if publish_date < CUTOFF_DATE:
            continue
        # Announce mode from the bag's dropdown, stamped by promote
        # (PIPE-20/PIPE-29): absent = announce, "false" = never announce,
        # "force" = announce even inside the flood guard.
        mode = str(fm.get("bluesky_announce", "")).strip().lower()
        if mode == "false":
            continue
        posts.append({
            "slug": name[:-3],
            "title": fm.get("title", name[:-3]),
            "excerpt": fm.get("excerpt", ""),
            "body": strip_frontmatter(raw),
            "publish_date": publish_date,
            "url": f"{SUBSTACK_URL}/p/{name[:-3]}",
            "forced": mode == "force",
        })
    posts.sort(key=lambda p: p["publish_date"])
    return posts


def load_credentials() -> dict:
    # The Routine's container has no AWS credentials and must not be given any —
    # cloud environment variables are visible to anyone using the environment, so
    # a revocable Bluesky app password is the only secret that goes in there.
    handle = os.environ.get("BLUESKY_HANDLE")
    app_password = os.environ.get("BLUESKY_APP_PASSWORD")
    if handle and app_password:
        return {"handle": handle, "app_password": app_password}

    import boto3

    ssm = boto3.client("ssm", region_name=AWS_REGION)
    try:
        value = ssm.get_parameter(Name=CREDS_PARAM, WithDecryption=True)["Parameter"]["Value"]
    except ssm.exceptions.ParameterNotFound:
        sys.exit(
            f"error: SSM parameter {CREDS_PARAM} not found — store "
            '{"handle": ..., "app_password": ...} there (SecureString).'
        )
    return json.loads(value)


def announced_state(client, handle: str) -> tuple[set[str], datetime.datetime | None]:
    """(Substack URLs already linked from own posts, timestamp of latest such post)."""
    urls: set[str] = set()
    latest: datetime.datetime | None = None
    cursor = None
    for _ in range(3):  # up to ~300 posts of history — plenty at this cadence
        feed = client.get_author_feed(actor=handle, limit=100, cursor=cursor)
        for item in feed.feed:
            post = item.post
            if post.author.handle != handle:
                continue  # repost of someone else
            # Only links to an actual post (/p/...) count as announcements.
            # A card linking the publication root — e.g. the pinned intro
            # post — must not restart the 3-day gap clock.
            post_link = f"{SUBSTACK_URL}/p/"
            found = set()
            embed = getattr(post.record, "embed", None)
            external = getattr(embed, "external", None)
            uri = getattr(external, "uri", "") or ""
            if post_link in uri:
                found.add(uri.split("?")[0].rstrip("/"))
            for m in re.finditer(r"https?://\S+", getattr(post.record, "text", "") or ""):
                if post_link in m.group(0):
                    found.add(m.group(0).split("?")[0].rstrip("/"))
            if found:
                urls |= found
                created = datetime.datetime.fromisoformat(
                    post.record.created_at.replace("Z", "+00:00")
                )
                if latest is None or created > latest:
                    latest = created
        cursor = feed.cursor
        if not cursor:
            break
    return urls, latest


def og_image(url: str) -> bytes | None:
    """The post's social-card image, for the link-card thumbnail."""
    try:
        page = requests.get(url, timeout=30)
        # Substack renders `<meta data-rh="true" property="og:image" …>` — the
        # tag can carry attributes before `property`, so match anywhere in it.
        m = re.search(
            r'<meta[^>]*property="og:image"[^>]*content="([^"]+)"', page.text
        )
        if not m:
            return None
        img = requests.get(m.group(1), timeout=30)
        return img.content if img.ok and len(img.content) < 950_000 else None
    except requests.RequestException:
        return None


BEDROCK_MODEL = os.environ.get("BLUESKY_TEASER_MODEL", "eu.anthropic.claude-sonnet-4-6")

TEASER_PROMPT = """Write a Bluesky post announcing this blog post. It links to the article, so \
its job is to make someone curious enough to click — NOT to summarise.

Voice: first-person, wry, conversational British English — a maker sharing a \
war story, not a marketer. No hashtags, no emoji, no "New blog post!", no \
"check out". Don't reuse the article's opening paragraph or its excerpt \
verbatim. One or two sentences, and it MUST be under 280 characters total. \
Trailing ellipsis as a hook is welcome but optional.

Example of the register (for a post about pinning a chatbot to one topic):
"Given the fact that virtually every website now has an AI bot on it, you'd \
think that the problem of keeping a chatbot on a single topic would have an \
off-the-shelf solution, but there isn't one! No wonder so many of them are \
easy to persuade to go astray..."

Title: {title}

Article:
{body}

NEVER include a URL, link, or domain name of any kind. The link is attached \
separately as a card — a URL in the text is always wrong, and inventing one is \
worse.

Reply with ONLY the post text — no quotes, no preamble."""

# Belt and braces: the prompt forbids URLs, but a prompt is not a guarantee.
# A teaser once shipped with a hallucinated "https://blog.example.com/..." in
# it, which is public and wrong the moment it posts. Anything URL-shaped is
# stripped, and if that guts the teaser we fall back to title+excerpt.
URL_RE = re.compile(
    r"\bhttps?://\S+"                                   # any explicit URL
    r"|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|uk|ai)\b\S*",  # bare domains,
    re.I,                                               # subdomains included
)


def fallback_text(post: dict) -> str:
    """Title + excerpt — what ships when a teaser can't be trusted."""
    text = post["title"]
    excerpt = post["excerpt"]
    if excerpt:
        room = MAX_POST_CHARS - len(text) - 2
        if len(excerpt) > room:
            excerpt = excerpt[: room - 1].rsplit(" ", 1)[0] + "…"
        text = f"{text}\n\n{excerpt}"
    return text


def guard_teaser(teaser: str, post: dict) -> str:
    """Vet a model-written teaser. Deterministic — no model runs in here.

    This is the guard the whole PIPE-32 design is arranged around. It does not
    care which model wrote the teaser or which side of the fence it came from:
    anything URL-shaped is stripped, and a teaser that doesn't survive that is
    replaced with title+excerpt rather than shipped.
    """
    text = teaser.strip().strip('"')
    stripped = URL_RE.sub("", text)
    stripped = re.sub(r"\s{2,}", " ", stripped).strip(" \t:—-").strip()
    if stripped != text:
        # Don't salvage. A teaser containing a URL was written *around* that URL,
        # so cutting it out leaves prose that reads wrong — "Full write-up at",
        # "Read more here:" — and that ships publicly the moment it posts. The
        # model was told not to include links; if it did, distrust the sentence,
        # not just the substring.
        print(
            f"warn: teaser contained a URL, discarding it entirely: {text!r}",
            file=sys.stderr,
        )
        return fallback_text(post)
    if 40 < len(stripped) <= MAX_POST_CHARS:
        return stripped
    print(f"warn: teaser length {len(stripped)} out of range, falling back", file=sys.stderr)
    return fallback_text(post)


def compose_text(post: dict) -> str:
    """An AI-written teaser in Martin's voice; title+excerpt as the fallback.

    The Bedrock path. Kept intact as the PIPE-32 rollback — if the Routine turns
    out to be a bad idea, dropping the two new workflow steps restores this.
    """
    try:
        import boto3

        bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)
        resp = bedrock.converse(
            modelId=BEDROCK_MODEL,
            messages=[{
                "role": "user",
                "content": [{"text": TEASER_PROMPT.format(
                    title=post["title"], body=post["body"][:BODY_CHARS],
                )}],
            }],
            inferenceConfig={"maxTokens": 300, "temperature": 0.8},
        )
        teaser = resp["output"]["message"]["content"][0]["text"]
    except Exception as err:  # noqa: BLE001 — a broken teaser must not block the announcement
        print(f"warn: teaser generation failed ({err}), falling back", file=sys.stderr)
        return fallback_text(post)

    return guard_teaser(teaser, post)


def select_post(client, handle: str, content_dir: str) -> dict | None:
    """The post to announce this run, or None. Every gating rule lives here.

    Runs on the GitHub runner, never inside the Routine — the flood guard and the
    feed-idempotency check must not be a model's responsibility.
    """
    candidates = candidate_posts(content_dir)
    if not candidates:
        print("No post-cutoff posts are live; nothing to announce.", file=sys.stderr)
        return None

    announced, latest = announced_state(client, handle)

    pending = [p for p in candidates if p["url"].rstrip("/") not in announced]
    # Forced posts (PIPE-29) jump the queue and, below, the flood guard.
    # Stable sort keeps oldest-first within each group.
    pending.sort(key=lambda p: not p["forced"])

    now = datetime.datetime.now(datetime.timezone.utc)
    guarded = latest is not None and (now - latest) < datetime.timedelta(
        hours=MIN_GAP_HOURS
    )
    if guarded and not (pending and pending[0]["forced"]):
        print(
            f"Last announcement was {latest.isoformat()} — inside the "
            f"{MIN_GAP_HOURS}-hour flood guard, not posting.",
            file=sys.stderr,
        )
        return None

    if not pending:
        print("Every eligible post is already announced.", file=sys.stderr)
        return None

    return pending[0]


def fire_payload(post: dict) -> str:
    """The body of the /fire call: one metadata line, a marker, then the article.

    Single-line JSON on purpose — the Routine has to copy it to a file verbatim,
    and a one-liner survives that far more reliably than a pretty-printed blob.
    """
    meta = json.dumps(
        {
            "slug": post["slug"],
            "title": post["title"],
            "excerpt": post["excerpt"],
            "url": post["url"],
        },
        separators=(",", ":"),
    )
    return f"{meta}\n{ARTICLE_MARKER}\n{post['body'][:BODY_CHARS]}"


def load_payload(path: str) -> dict:
    """Read and validate the metadata the Routine copied out of the fire payload.

    The model copies this blob by hand, so treat it as suspect: require every
    field, and check the URL against the slug. A corrupted copy then fails closed
    instead of announcing a post under the wrong link.
    """
    with open(path, encoding="utf-8") as fh:
        raw = fh.read().strip()
    try:
        meta = json.loads(raw)
    except json.JSONDecodeError as err:
        sys.exit(f"error: {path} is not valid JSON ({err})")

    missing = [k for k in ("slug", "title", "excerpt", "url") if not meta.get(k)]
    if missing:
        sys.exit(f"error: payload is missing {', '.join(missing)}")

    expected = f"{SUBSTACK_URL}/p/{meta['slug']}"
    if meta["url"].rstrip("/") != expected:
        sys.exit(
            f"error: payload url {meta['url']!r} does not match its slug "
            f"(expected {expected!r}) — refusing to announce a mismatched link."
        )
    return meta


def announce(client, models, post: dict, text: str) -> None:
    """Upload the card thumbnail and send the post."""
    thumb_bytes = og_image(post["url"])
    thumb = client.upload_blob(thumb_bytes).blob if thumb_bytes else None
    embed = models.AppBskyEmbedExternal.Main(
        external=models.AppBskyEmbedExternal.External(
            uri=post["url"],
            title=post["title"],
            description=post["excerpt"][:280],
            thumb=thumb,
        )
    )
    client.send_post(text=text, embed=embed)
    print(f"announced on Bluesky: {post['slug']} -> {post['url']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content-dir", default="web/content/blog")
    parser.add_argument("--dry-run", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--select", action="store_true",
        help="print a /fire payload for the teaser Routine, or nothing",
    )
    mode.add_argument(
        "--post", action="store_true",
        help="post a Routine-written teaser (requires --payload and --teaser)",
    )
    parser.add_argument("--payload", help="metadata JSON file, for --post")
    parser.add_argument("--teaser", help="the model-written teaser, for --post")
    args = parser.parse_args()

    if args.post and not (args.payload and args.teaser):
        parser.error("--post requires both --payload and --teaser")

    from atproto import Client, models

    creds = load_credentials()
    client = Client()
    client.login(creds["handle"], creds["app_password"])

    if args.post:
        post = load_payload(args.payload)
        # Second idempotency check. The first ran on the runner minutes ago;
        # this one closes the gap between firing and posting, and it is the
        # guard that failed the day a post went out twice.
        announced, _ = announced_state(client, creds["handle"])
        if post["url"].rstrip("/") in announced:
            print(f"{post['slug']} is already announced; not posting again.")
            return
        text = guard_teaser(args.teaser, post)
        if args.dry_run:
            print(f"DRY RUN: would announce {post['slug']}\n---\n{text}\n---\n{post['url']}")
            return
        announce(client, models, post, text)
        return

    post = select_post(client, creds["handle"], args.content_dir)
    if post is None:
        return

    if args.select:
        # stdout is the payload and nothing else — the workflow treats an empty
        # stdout as "nothing to announce" and skips the fire entirely.
        print(fire_payload(post))
        return

    # No mode flag: the original single-pass behaviour, teaser from Bedrock.
    text = compose_text(post)
    if args.dry_run:
        print(f"DRY RUN: would announce {post['slug']}\n---\n{text}\n---\n{post['url']}")
        return
    announce(client, models, post, text)


if __name__ == "__main__":
    main()
