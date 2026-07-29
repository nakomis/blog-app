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
  - Nothing is posted if the profile's latest Substack-linking post (manual or
    automated — both count) is under MIN_GAP_DAYS old.
  - Idempotent by URL: the profile's own feed is the record of what has been
    announced; anything linking a post's Substack URL suppresses it forever.

Auth is an app password in SSM (`/blog/prod/bluesky/credentials`, JSON
`{"handle": ..., "app_password": ...}`).
"""
import argparse
import datetime
import json
import os
import re
import sys

import boto3
import requests

CREDS_PARAM = os.environ.get("BLUESKY_CREDS_PARAM", "/blog/prod/bluesky/credentials")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-2")
SUBSTACK_URL = "https://nakomis.substack.com"

CUTOFF_DATE = "2026-07-29"
MIN_GAP_DAYS = 3
MAX_POST_CHARS = 300

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


def candidate_posts(content_dir: str) -> list[dict]:
    """Live posts published on/after the cutoff, oldest first."""
    today = datetime.date.today().isoformat()
    posts = []
    for name in sorted(os.listdir(content_dir)):
        m = FILE_RE.match(name)
        if not m:
            continue
        with open(os.path.join(content_dir, name), encoding="utf-8") as fh:
            fm = parse_frontmatter(fh.read())
        approved = str(fm.get("approved", "")).strip().lower() == "true"
        publish_date = fm.get("publish_date") or fm.get("date", "")
        if not approved or not publish_date or publish_date > today:
            continue
        if publish_date < CUTOFF_DATE:
            continue
        # Opt-out: unticking "announce on Bluesky" in the bag makes promote
        # stamp this into the frontmatter (PIPE-20).
        if str(fm.get("bluesky_announce", "true")).strip().lower() == "false":
            continue
        with open(os.path.join(content_dir, name), encoding="utf-8") as fh:
            raw = fh.read()
        body = raw.split("\n---", 2)[-1] if raw.startswith("---\n") else raw
        posts.append({
            "slug": name[:-3],
            "title": fm.get("title", name[:-3]),
            "excerpt": fm.get("excerpt", ""),
            "body": body,
            "publish_date": publish_date,
            "url": f"{SUBSTACK_URL}/p/{name[:-3]}",
        })
    posts.sort(key=lambda p: p["publish_date"])
    return posts


def load_credentials() -> dict:
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
        m = re.search(r'<meta property="og:image" content="([^"]+)"', page.text)
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

Reply with ONLY the post text — no quotes, no preamble."""


def compose_text(post: dict) -> str:
    """An AI-written teaser in Martin's voice; title+excerpt as the fallback."""
    try:
        bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)
        resp = bedrock.converse(
            modelId=BEDROCK_MODEL,
            messages=[{
                "role": "user",
                "content": [{"text": TEASER_PROMPT.format(
                    title=post["title"], body=post["body"][:6000],
                )}],
            }],
            inferenceConfig={"maxTokens": 300, "temperature": 0.8},
        )
        text = resp["output"]["message"]["content"][0]["text"].strip().strip('"')
        if 0 < len(text) <= MAX_POST_CHARS:
            return text
        print(f"warn: teaser length {len(text)} out of range, falling back", file=sys.stderr)
    except Exception as err:  # noqa: BLE001 — a broken teaser must not block the announcement
        print(f"warn: teaser generation failed ({err}), falling back", file=sys.stderr)

    text = post["title"]
    excerpt = post["excerpt"]
    if excerpt:
        room = MAX_POST_CHARS - len(text) - 2
        if len(excerpt) > room:
            excerpt = excerpt[: room - 1].rsplit(" ", 1)[0] + "…"
        text = f"{text}\n\n{excerpt}"
    return text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-dir", default="web/content/blog")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    candidates = candidate_posts(args.content_dir)
    if not candidates:
        print("No post-cutoff posts are live; nothing to announce.")
        return

    from atproto import Client, models

    creds = load_credentials()
    client = Client()
    client.login(creds["handle"], creds["app_password"])

    announced, latest = announced_state(client, creds["handle"])

    now = datetime.datetime.now(datetime.timezone.utc)
    if latest is not None and (now - latest) < datetime.timedelta(days=MIN_GAP_DAYS):
        print(
            f"Last announcement was {latest.isoformat()} — inside the "
            f"{MIN_GAP_DAYS}-day gap, not posting."
        )
        return

    pending = [p for p in candidates if p["url"].rstrip("/") not in announced]
    if not pending:
        print("Every eligible post is already announced.")
        return

    post = pending[0]
    text = compose_text(post)
    if args.dry_run:
        print(f"DRY RUN: would announce {post['slug']}\n---\n{text}\n---\n{post['url']}")
        return

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


if __name__ == "__main__":
    main()
