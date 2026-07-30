#!/usr/bin/env python3
"""One-shot backfill: give already-mirrored Substack posts their code languages.

BAPP-8 fixed the mirror so *new* posts emit `highlighted_code_block` (attrs
{language, nodeId}), which Substack renders through Shiki. Posts mirrored
before that fix carry the legacy `codeBlock` node — a bare <pre><code> with no
highlighting — and will never fix themselves. This script rewrites them in
place.

THE CATCH: a legacy `codeBlock` has no language. That was the bug — the
language never reached Substack, so it cannot be read back out of the post.
It has to be recovered from the source markdown in blog-content, by matching
the Nth code block in the post to the Nth fence in the post's markdown.

That positional match is only safe if the counts agree exactly, so a post whose
block count differs from its fence count is SKIPPED rather than guessed at. In
practice a mismatch means the post was hand-edited on Substack after mirroring.

This rewrites live, published content. Accordingly:

  * it is dry-run by default; --apply is required to write anything
  * --slug does a single post, which is how you should start
  * republishing always uses send=False, so no subscriber email goes out
  * post_date is read back and passed through, so republishing cannot silently
    re-date a backfilled post to today

Usage:
    python scripts/substack-backfill-code-langs.py --content-dir web/content/blog
    python scripts/substack-backfill-code-langs.py --content-dir web/content/blog \
        --slug 2026-06-03-why-i-switched-to-pnpm --apply
"""
import argparse
import importlib.util
import json
import os
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))

# substack-sync.py is not importable by name (hyphen), and it is the single
# source of truth for the session cookie, the API connection and the markdown
# preparation. Load it by path rather than duplicating any of that.
_spec = importlib.util.spec_from_file_location(
    "substack_sync", os.path.join(HERE, "substack-sync.py")
)
sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync)


def fence_languages(md: str) -> list[str]:
    """Languages of each fenced block, in document order.

    Mirrors sync.count_fences' fence tracking exactly — the two must agree or
    the positional match below is unsound.
    """
    langs, fence = [], None
    for line in md.split("\n"):
        m = sync.FENCE_RE.match(line)
        if m and (fence is None or line.strip().startswith(fence)):
            if fence is None:
                fence = m.group(2)
                langs.append((m.group(3).strip().lower() or sync.DEFAULT_CODE_LANG))
            else:
                fence = None
    return langs


def walk_code_blocks(nodes):
    """Yield every legacy codeBlock node, depth-first, in document order.

    Code blocks nest inside lists and blockquotes, so a flat scan of the top
    level would miss some and throw the positional match out of step.
    """
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("type") == "codeBlock":
            yield node
        for key in ("content",):
            child = node.get(key)
            if isinstance(child, list):
                yield from walk_code_blocks(child)


def node_text(node: dict) -> str:
    return "".join(
        c.get("text", "") for c in node.get("content", []) if isinstance(c, dict)
    )


def convert(node: dict, language: str) -> None:
    """Rewrite a legacy codeBlock in place into a highlighted_code_block."""
    node["type"] = "highlighted_code_block"
    attrs = node.setdefault("attrs", {})
    attrs["language"] = language
    attrs.setdefault("nodeId", str(uuid.uuid4()))


def markdown_by_slug(content_dir: str) -> dict:
    """slug -> prepared markdown, matching exactly what was mirrored."""
    out = {}
    for post in sync.live_posts(content_dir):
        out[post["slug"]] = sync.prepare_markdown(post)
    return out


def backfill(api, post_meta: dict, md: str, apply: bool) -> str:
    """Returns a one-line status for this post."""
    slug = post_meta["slug"]
    draft = api.get_draft(post_meta["id"])
    body_raw = draft.get("draft_body") or "{}"
    body = json.loads(body_raw) if isinstance(body_raw, str) else body_raw

    content = body.get("content", body if isinstance(body, list) else [])
    blocks = list(walk_code_blocks(content))
    langs = fence_languages(md)

    if not blocks:
        already = body_raw.count('"highlighted_code_block"')
        return f"skip  {slug}: no legacy code blocks" + (
            f" ({already} already converted)" if already else ""
        )
    if len(blocks) != len(langs):
        return (
            f"SKIP  {slug}: {len(blocks)} code blocks but {len(langs)} fences in "
            "markdown — refusing to guess (hand-edited on Substack?)"
        )

    for node, lang in zip(blocks, langs):
        convert(node, lang)

    summary = ", ".join(sorted({l for l in langs}))
    if not apply:
        return f"WOULD  {slug}: convert {len(blocks)} blocks ({summary})"

    kwargs = {"draft_body": json.dumps(body)}
    # Republishing without this can re-date the post to now.
    if draft.get("post_date"):
        kwargs["post_date"] = draft["post_date"]
    api.put_draft(post_meta["id"], **kwargs)
    api.publish_draft(post_meta["id"], send=False, share_automatically=False)
    return f"done  {slug}: converted {len(blocks)} blocks ({summary})"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-dir", required=True,
                        help="blog-content posts directory")
    parser.add_argument("--slug", help="backfill a single post (do this first)")
    parser.add_argument("--apply", action="store_true",
                        help="actually write; without it, dry run")
    args = parser.parse_args()

    api = sync.connect(sync.load_session_cookie())
    md_by_slug = markdown_by_slug(args.content_dir)

    published, offset, limit = [], 0, 25
    while True:
        page = api.get_published_posts(offset=offset, limit=limit)
        items = page if isinstance(page, list) else page.get("posts", [])
        published.extend(items)
        if len(items) < limit:
            break
        offset += len(items)

    if not args.apply:
        print("DRY RUN — nothing will be written. Re-run with --apply.\n")

    changed = 0
    for meta in published:
        slug = meta.get("slug", "")
        if args.slug and slug != args.slug:
            continue
        md = md_by_slug.get(slug)
        if md is None:
            print(f"skip  {slug}: no matching markdown in content dir")
            continue
        try:
            line = backfill(api, meta, md, args.apply)
        except Exception as err:  # noqa: BLE001 — report and carry on
            line = f"ERROR {slug}: {err}"
        print(line)
        changed += line.startswith(("done", "WOULD"))

    if args.slug and changed == 0:
        sys.exit(f"error: no published post matched --slug {args.slug}")
    print(f"\n{changed} post(s) {'converted' if args.apply else 'would be converted'}")


if __name__ == "__main__":
    main()
