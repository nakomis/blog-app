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

The chat Lambda loads the small S3 file at cold start, runs cosine similarity
to find the top-K chunk IDs, then fetches the matching text/metadata from
DynamoDB via BatchGetItem.

Usage:
    AWS_PROFILE=nakom.is-admin python scripts/ingest-blog.py
"""

import base64
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

    # S3 records: id + binary embedding + fields needed client-side (dedup, HyDE tags)
    s3_records:  list[dict] = []
    # DDB records: id + full text/metadata (fetched after cosine search)
    ddb_records: list[dict] = []

    for key in sorted(keys):
        slug = Path(key).stem
        print(f"\n── {slug}")

        content = download_post(s3, key)
        fm, body = parse_frontmatter(content)

        # Skip posts that aren't published yet
        publish_date = fm.get("publish_date") or fm.get("date", "")
        if not publish_date or publish_date > date.today().isoformat():
            print(f"   Skipping (not yet published: {publish_date or 'no date'})")
            continue

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

            s3_records.append({
                "id":        chunk_id,
                "post_slug": slug,
                "post_tags": tags,
                "embedding": encode_embedding(vector),
            })

            ddb_records.append({
                "id":         chunk_id,
                "post_slug":  slug,
                "post_title": title,
                "post_date":  post_date,
                "post_url":   post_url,
                "heading":    heading,
                "text":       chunk_text,
            })

        print(f"   {len(chunks)} chunk(s) embedded    ")

    total = len(s3_records)
    print(f"\nTotal chunks: {total}")

    print(f"Writing {total} chunk(s) to DynamoDB table '{CHUNKS_TABLE}'...")
    write_chunks_to_ddb(ddb, ddb_records)
    print("DynamoDB write complete.")

    payload  = json.dumps(s3_records, separators=(",", ":"))
    size_kb  = len(payload.encode()) / 1024
    print(f"S3 payload size: {size_kb:.1f} KB")

    print(f"Uploading to s3://{PRIVATE_BUCKET}/{EMBEDDINGS_KEY} ...")
    s3.put_object(
        Bucket=PRIVATE_BUCKET,
        Key=EMBEDDINGS_KEY,
        Body=payload.encode(),
        ContentType="application/json",
    )
    print("Done.")


if __name__ == "__main__":
    main()
