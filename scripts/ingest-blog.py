#!/usr/bin/env python3
"""
Blog RAG ingestion script.

Downloads blog posts from S3, splits them into overlapping chunks using
LangChain's MarkdownTextSplitter, embeds each chunk via Amazon Titan Embed v2
(Bedrock), then:

  - Writes text/metadata for each chunk to the DynamoDB `blog-chunks` table
    (keyed on chunk ID).
  - Uploads a compact `blog-embeddings.json` to the private S3 bucket
    containing only chunk IDs and base64-encoded Float32 embeddings (plus the
    post_slug and post_tags needed for deduplication and HyDE tag expansion).

Incremental processing: a content-hash manifest (`ingest-manifest.json`) in
the private bucket tracks the SHA-256 of each post at last ingest. Only posts
whose content has changed (or that are new) are re-embedded. Unchanged posts
are skipped entirely; their existing records are preserved as-is.

The chat Lambda loads the small S3 file at cold start, runs cosine similarity
to find the top-K chunk IDs, then fetches the matching text/metadata from
DynamoDB via BatchGetItem.

Usage:
    AWS_PROFILE=nakom.is-admin python scripts/ingest-blog.py
"""

import base64
import hashlib
import json
import re
import struct
import sys
from datetime import date
import boto3
from pathlib import Path
from langchain_text_splitters import MarkdownTextSplitter

# ── Config ────────────────────────────────────────────────────────────────────

BLOG_BUCKET    = "blog-nakom-is-eu-west-2-637423226886"
PRIVATE_BUCKET = "nakom.is-private"
EMBEDDINGS_KEY = "blog-embeddings.json"
MANIFEST_KEY   = "ingest-manifest.json"
CHUNKS_TABLE   = "blog-chunks"
BEDROCK_REGION = "us-east-1"
EMBED_MODEL    = "amazon.titan-embed-text-v2:0"
EMBED_DIMS     = 1024
CHUNK_SIZE     = 700  # characters per chunk
CHUNK_OVERLAP  = 80   # overlap between consecutive chunks


# ── Embedding ─────────────────────────────────────────────────────────────────

def embed(bedrock, text: str) -> list[float]:
    response = bedrock.invoke_model(
        modelId=EMBED_MODEL,
        body=json.dumps({"inputText": text, "dimensions": EMBED_DIMS, "normalize": True}),
        contentType="application/json",
        accept="application/json",
    )
    return json.loads(response["body"].read())["embedding"]


def encode_embedding(vector: list[float]) -> str:
    """Pack a float list as a base64-encoded Float32 binary string."""
    return base64.b64encode(struct.pack(f"{len(vector)}f", *vector)).decode()


# ── S3 helpers ────────────────────────────────────────────────────────────────

def list_post_keys(s3) -> list[str]:
    paginator = s3.get_paginator("list_objects_v2")
    keys = []
    for page in paginator.paginate(Bucket=BLOG_BUCKET, Prefix="posts/"):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(".md"):
                keys.append(obj["Key"])
    return keys


def download_post(s3, key: str) -> str:
    obj = s3.get_object(Bucket=BLOG_BUCKET, Key=key)
    return obj["Body"].read().decode("utf-8")


def load_json_from_s3(s3, bucket: str, key: str, default):
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read().decode("utf-8"))
    except s3.exceptions.NoSuchKey:
        return default
    except Exception as e:
        print(f"  Warning: could not load s3://{bucket}/{key}: {e}")
        return default


def upload_json_to_s3(s3, bucket: str, key: str, data) -> None:
    payload = json.dumps(data, separators=(",", ":"))
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=payload.encode(),
        ContentType="application/json",
    )


# ── Hashing ───────────────────────────────────────────────────────────────────

def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# ── Parsing ───────────────────────────────────────────────────────────────────

def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Split YAML frontmatter from body. Returns (fm dict, body string)."""
    if not content.startswith("---"):
        return {}, content
    end = content.index("---", 3)
    fm_text = content[3:end].strip()
    body    = content[end + 3:].strip()

    fm: dict[str, str] = {}
    for line in fm_text.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fm[key.strip()] = value.strip().strip('"').strip("'")
    return fm, body


_splitter = MarkdownTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)


def chunk_body(body: str) -> list[str]:
    """Split a post body into chunks using LangChain's MarkdownTextSplitter.

    Splits on markdown structure (headings, code fences, paragraphs) in priority
    order, falling back to sentences then words. Overlap between chunks preserves
    context across boundaries.
    """
    return _splitter.split_text(body)


def extract_heading(chunk: str) -> str:
    """Return the text of the first heading line in a chunk, or empty string."""
    first_line = chunk.split("\n")[0]
    m = re.match(r"^#{1,3}\s+(.+)", first_line)
    return m.group(1).strip() if m else ""


# ── DynamoDB helpers ──────────────────────────────────────────────────────────

def write_chunks_to_ddb(ddb, records: list[dict]) -> None:
    """Batch-write chunk metadata records to DynamoDB."""
    table = ddb.Table(CHUNKS_TABLE)
    with table.batch_writer() as batch:
        for record in records:
            batch.put_item(Item=record)


def delete_chunks_from_ddb(ddb, chunk_ids: list[str]) -> None:
    """Batch-delete chunk records from DynamoDB by ID."""
    if not chunk_ids:
        return
    table = ddb.Table(CHUNKS_TABLE)
    with table.batch_writer() as batch:
        for chunk_id in chunk_ids:
            batch.delete_item(Key={"id": chunk_id})


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    s3      = boto3.client("s3")
    bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
    ddb     = boto3.resource("dynamodb")

    print("Listing blog posts...")
    keys = list_post_keys(s3)
    if not keys:
        print("No posts found — check bucket name and AWS profile.", file=sys.stderr)
        sys.exit(1)
    print(f"Found {len(keys)} post(s)")

    print("Loading manifest and existing embeddings...")
    manifest         = load_json_from_s3(s3, PRIVATE_BUCKET, MANIFEST_KEY, {})
    existing_records = load_json_from_s3(s3, PRIVATE_BUCKET, EMBEDDINGS_KEY, [])

    # Index existing embedding records by slug for fast lookup
    old_records_by_slug: dict[str, list[dict]] = {}
    for record in existing_records:
        old_records_by_slug.setdefault(record["post_slug"], []).append(record)

    # ── First pass: determine which slugs need reprocessing ──────────────────

    today_str = date.today().isoformat()
    live_posts: dict[str, tuple[dict, str, str]] = {}  # slug -> (fm, body, hash)

    for key in sorted(keys):
        slug    = Path(key).stem
        content = download_post(s3, key)
        fm, body = parse_frontmatter(content)

        publish_date = fm.get("publish_date") or fm.get("date", "")
        if not publish_date or publish_date > today_str:
            continue  # not yet published

        live_posts[slug] = (fm, body, content_hash(content))

    slugs_to_reprocess = {
        slug for slug, (_, _, h) in live_posts.items()
        if manifest.get(slug) != h
    }
    slugs_removed = set(old_records_by_slug) - set(live_posts)

    unchanged = len(live_posts) - len(slugs_to_reprocess)
    print(f"  {unchanged} post(s) unchanged — skipping")
    print(f"  {len(slugs_to_reprocess)} post(s) to embed: {sorted(slugs_to_reprocess) or 'none'}")
    if slugs_removed:
        print(f"  {len(slugs_removed)} post(s) removed from index: {sorted(slugs_removed)}")

    if not slugs_to_reprocess and not slugs_removed:
        print("Nothing to do.")
        return

    # ── Delete old DynamoDB chunks for changed/removed slugs ─────────────────

    slugs_to_clean = slugs_to_reprocess | slugs_removed
    old_ids_to_delete = [
        r["id"]
        for slug in slugs_to_clean
        for r in old_records_by_slug.get(slug, [])
    ]
    if old_ids_to_delete:
        print(f"Deleting {len(old_ids_to_delete)} stale chunk(s) from DynamoDB...")
        delete_chunks_from_ddb(ddb, old_ids_to_delete)

    # ── Keep embedding records for unchanged slugs ────────────────────────────

    kept_records = [
        r for r in existing_records
        if r["post_slug"] not in slugs_to_clean
    ]

    # ── Second pass: embed changed/new posts ──────────────────────────────────

    new_s3_records:  list[dict] = []
    new_ddb_records: list[dict] = []

    for slug in sorted(slugs_to_reprocess):
        fm, body, h = live_posts[slug]
        print(f"\n── {slug}")

        title     = fm.get("title", slug)
        post_date = fm.get("date", "")
        post_url  = fm.get("canonical", "")
        tags      = re.findall(r'"([^"]+)"', fm.get("tags", ""))

        chunks = chunk_body(body)
        print(f"   {len(chunks)} chunk(s)")

        for i, chunk_text in enumerate(chunks):
            chunk_id = f"{slug}:{i}"
            heading  = extract_heading(chunk_text)

            print(f"   embedding {i + 1}/{len(chunks)}...", end="\r", flush=True)
            vector = embed(bedrock, chunk_text)

            new_s3_records.append({
                "id":        chunk_id,
                "post_slug": slug,
                "post_tags": tags,
                "embedding": encode_embedding(vector),
            })

            new_ddb_records.append({
                "id":         chunk_id,
                "post_slug":  slug,
                "post_title": title,
                "post_date":  post_date,
                "post_url":   post_url,
                "heading":    heading,
                "text":       chunk_text,
            })

        print(f"   {len(chunks)} chunk(s) embedded    ")
        manifest[slug] = h

    # ── Write results ─────────────────────────────────────────────────────────

    if new_ddb_records:
        print(f"\nWriting {len(new_ddb_records)} new chunk(s) to DynamoDB...")
        write_chunks_to_ddb(ddb, new_ddb_records)
        print("DynamoDB write complete.")

    final_records = kept_records + new_s3_records
    total = len(final_records)

    # Remove manifest entries for slugs that are no longer live
    for slug in slugs_removed:
        manifest.pop(slug, None)

    payload  = json.dumps(final_records, separators=(",", ":"))
    size_kb  = len(payload.encode()) / 1024
    print(f"\nTotal chunks in index: {total} ({size_kb:.1f} KB)")

    print(f"Uploading embeddings to s3://{PRIVATE_BUCKET}/{EMBEDDINGS_KEY} ...")
    s3.put_object(
        Bucket=PRIVATE_BUCKET,
        Key=EMBEDDINGS_KEY,
        Body=payload.encode(),
        ContentType="application/json",
    )

    print(f"Uploading manifest to s3://{PRIVATE_BUCKET}/{MANIFEST_KEY} ...")
    upload_json_to_s3(s3, PRIVATE_BUCKET, MANIFEST_KEY, manifest)

    print("Done.")


if __name__ == "__main__":
    main()
