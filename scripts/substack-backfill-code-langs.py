#!/usr/bin/env python3
"""One-shot backfill: give already-mirrored Substack posts their code languages.

BAPP-8 fixed the mirror so *new* posts emit `highlighted_code_block` (attrs
{language, nodeId}), which Substack renders through Shiki. Posts mirrored
before that fix carry the legacy `codeBlock` node — a bare <pre><code> with no
highlighting — and will never fix themselves. This script rewrites them in
place.

The languages are already there. Inspecting stored bodies showed that the
legacy nodes retain `attrs.language` perfectly well ("nginx", "python", "yaml"
…) — the language always did reach Substack. The bug was only ever the node
type, so this is a retype, not a reconstruction, and the stored language is
authoritative.

The source markdown is used only as a fallback, for blocks that never had a
language because their fence carried no info string — and only when every code
node in the post lines up with a fence. A post part-converted by hand does not
line up, so it falls back to Substack's default rather than being matched
positionally against the wrong fences.

This rewrites live, published content. Accordingly:

  * it is dry-run by default; --apply is required to write anything
  * --slug does a single post, which is how you should start
  * republishing always uses send=False, so no subscriber email goes out
  * post_date is read back and passed through, so republishing cannot silently
    re-date a backfilled post to today

Needs the venv — python-substack is not in the system Python:

    python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt

Usage (residential IP required; Substack's Cloudflare challenges datacentre
addresses, so run this from a Mac rather than CI):

    .venv/bin/python scripts/substack-backfill-code-langs.py \
        --content-dir web/content/blog
    .venv/bin/python scripts/substack-backfill-code-langs.py \
        --content-dir web/content/blog \
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


# Substack stores three code node types and highlights exactly one of them:
#
#   codeBlock              what python-substack POSTs           not highlighted
#   code_block             the editor's normalisation on save   not highlighted
#   highlighted_code_block Shiki                                highlighted
#
# Both legacy forms retain attrs.language perfectly well — the language always
# did reach Substack. The bug is only ever the node type.
LEGACY_CODE_TYPES = ("codeBlock", "code_block")
CODE_TYPES = LEGACY_CODE_TYPES + ("highlighted_code_block",)


def walk_code_blocks(nodes, types=LEGACY_CODE_TYPES):
    """Yield code nodes of the given types, depth-first, in document order.

    Code blocks nest inside lists and blockquotes, so a flat scan of the top
    level would miss some and throw the positional fallback out of step.
    """
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("type") in types:
            yield node
        child = node.get("content")
        if isinstance(child, list):
            yield from walk_code_blocks(child, types)


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


def markdown_index(content_dir: str) -> tuple[dict, dict]:
    """(by slug, by normalised title) -> prepared markdown as mirrored.

    Substack does not always keep our slug: the certificate post is filed here
    as 2026-02-26-the-certificate-that-had-to-live-in-america but mirrored as
    the-certificate-that-had-to-live. The sync script hits the same problem
    when deciding what is already published and falls back to comparing
    normalised titles, so do the same rather than skipping the post.
    """
    by_slug, by_title = {}, {}
    for post in sync.live_posts(content_dir):
        md = sync.prepare_markdown(post)
        by_slug[post["slug"]] = md
        by_title[sync.norm_title(post["title"])] = md
    return by_slug, by_title


def backfill(api, post_meta: dict, md: str, apply: bool) -> str:
    """Returns a one-line status for this post."""
    slug = post_meta["slug"]
    draft = api.get_draft(post_meta["id"])
    body_raw = draft.get("draft_body") or "{}"
    body = json.loads(body_raw) if isinstance(body_raw, str) else body_raw

    content = body.get("content", body if isinstance(body, list) else [])
    blocks = list(walk_code_blocks(content))

    if not blocks:
        already = body_raw.count('"highlighted_code_block"')
        return f"skip  {slug}: no legacy code blocks" + (
            f" ({already} already converted)" if already else ""
        )

    # The stored attrs.language is authoritative. The markdown is only a
    # fallback for blocks that never had one (a fence with no info string),
    # and only when every code node in the post lines up with a fence — a post
    # part-converted by hand does not, and must not be matched positionally.
    all_code = list(walk_code_blocks(content, CODE_TYPES))
    fences = fence_languages(md)
    aligned = len(all_code) == len(fences)
    fallback = dict(zip((id(n) for n in all_code), fences)) if aligned else {}

    applied, guessed = [], 0
    for node in blocks:
        stored = (node.get("attrs") or {}).get("language")
        lang = stored or fallback.get(id(node))
        if not stored:
            guessed += 1
        convert(node, lang or sync.DEFAULT_CODE_LANG)
        applied.append(lang or sync.DEFAULT_CODE_LANG)

    summary = ", ".join(sorted(set(applied)))
    if guessed:
        summary += f"; {guessed} from " + ("markdown" if aligned else "default")
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
    md_by_slug, md_by_title = markdown_index(args.content_dir)

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
        md = md_by_slug.get(slug) or md_by_title.get(
            sync.norm_title(meta.get("title", ""))
        )
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
