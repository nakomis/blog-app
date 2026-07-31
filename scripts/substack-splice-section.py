#!/usr/bin/env python3
"""Splice a new markdown section into a post already mirrored to Substack.

The mirror (substack-sync.py) only ever CREATES posts — it is idempotent by
slug and never updates one it has published before. So an edit made to a live
post in blog-content reaches the blog and never reaches Substack.

Re-rendering the whole body from markdown would fix that, but it would also
re-upload every image in the post to Substack's CDN and change their URLs, for
a change that touches no images. This splices instead: render only the new
markdown, find the anchor paragraph in the stored body, and insert after it.

Deliberately narrow, because it edits live published content:

  * dry-run by default; --apply required
  * ONE post, named by --slug — nothing else is read or written
  * the anchor text must match exactly once, or it refuses to guess
  * idempotent: a marker phrase already present means the work is done
  * publish uses send=False, so no subscriber email
  * post_date is passed back, so the post cannot be silently re-dated
  * does NOT touch Bluesky — announcements are a separate script, and this
    post has already been announced

Needs the venv (python-substack is not in the system Python):

    python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt

Usage:

    .venv/bin/python scripts/substack-splice-section.py \
        --slug 2026-07-30-the-1092-bytes-that-locked-a-terabyte \
        --markdown web/content/blog/2026-07-30-the-1092-bytes-that-locked-a-terabyte.md \
        --from-heading '### A full Hillary Clinton' \
        --anchor 'selling a drive on eBay' \
        --marker 'full Hillary Clinton'
"""
import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Load substack-sync by path (hyphen, not importable by name). It carries the
# session cookie, the API connection, and — importantly — the monkey-patches
# that make code blocks highlight and size known images correctly, so spliced
# nodes match what a fresh mirror would produce.
_spec = importlib.util.spec_from_file_location(
    "substack_sync", os.path.join(HERE, "substack-sync.py")
)
sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync)


def extract_section(path: str, from_heading: str) -> str:
    """The markdown from `from_heading` up to the next horizontal rule."""
    text = open(path, encoding="utf-8").read()
    if from_heading not in text:
        sys.exit(f"error: heading not found in {path}: {from_heading}")
    start = text.index(from_heading)
    end = text.find("\n---\n", start)
    section = text[start:end if end != -1 else len(text)]
    # Run it through the same preparation the mirror applies, so any {{...}}
    # directives or in-document links are handled identically.
    return sync.prepare_markdown({"body": section})


def node_text(node) -> str:
    """All text within a node, recursively."""
    if not isinstance(node, dict):
        return ""
    out = node.get("text", "") or ""
    for child in node.get("content", []) or []:
        out += node_text(child)
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--slug", required=True)
    p.add_argument("--markdown", required=True, help="source post markdown")
    p.add_argument("--from-heading", required=True,
                   help="heading that starts the new section")
    p.add_argument("--anchor", required=True,
                   help="text identifying the paragraph to insert AFTER")
    p.add_argument("--marker", required=True,
                   help="phrase proving the section is already present")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()

    from substack import mdrender

    md = extract_section(args.markdown, args.from_heading)
    new_nodes = mdrender.markdown_to_doc(md)
    if not new_nodes:
        sys.exit("error: the section rendered to nothing")

    api = sync.connect(sync.load_session_cookie())
    published = api.get_published_posts(offset=0, limit=50)
    items = published if isinstance(published, list) else published.get("posts", [])
    matches = [q for q in items if q.get("slug") == args.slug]
    if len(matches) != 1:
        sys.exit(f"error: {len(matches)} published posts match --slug {args.slug}")
    meta = matches[0]

    draft = api.get_draft(meta["id"])
    raw = draft.get("draft_body") or "{}"
    body = json.loads(raw) if isinstance(raw, str) else raw
    content = body.get("content", body if isinstance(body, list) else [])

    if args.marker in raw:
        print(f"skip: {args.slug} already contains {args.marker!r}")
        return

    hits = [i for i, n in enumerate(content) if args.anchor in node_text(n)]
    if len(hits) != 1:
        sys.exit(
            f"error: anchor {args.anchor!r} matched {len(hits)} top-level nodes "
            "— refusing to guess where to splice"
        )
    at = hits[0] + 1

    print(f"{args.slug}: inserting {len(new_nodes)} nodes after node {hits[0]} "
          f"({len(content)} -> {len(content) + len(new_nodes)})")
    print("  after:", node_text(content[hits[0]])[:90])
    print("  first new:", node_text(new_nodes[0])[:90])
    print("  last new :", node_text(new_nodes[-1])[:90])
    if at < len(content):
        print("  before:", node_text(content[at])[:90])

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return

    content[at:at] = new_nodes
    body["content"] = content
    kwargs = {"draft_body": json.dumps(body)}
    if draft.get("post_date"):
        kwargs["post_date"] = draft["post_date"]
    api.put_draft(meta["id"], **kwargs)
    api.publish_draft(meta["id"], send=False, share_automatically=False)
    print(f"\ndone: {args.slug} updated (no email, no announcement)")


if __name__ == "__main__":
    main()
