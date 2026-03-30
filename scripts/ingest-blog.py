#!/usr/bin/env python3
"""
Blog RAG ingestion script.

Downloads blog posts from S3, chunks at paragraph level (with section heading
context prepended to each chunk), embeds via Ollama (nomic-embed-text), and
uploads blog-embeddings.json to the private S3 bucket.

The chat Lambda reads this file at cold start and uses it for cosine similarity
search against Bedrock Titan-embedded user queries.

Usage:
    AWS_PROFILE=nakom.is python utils/ingest-blog.py
"""

import json
import re
import sys
from datetime import date
import boto3
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

BLOG_BUCKET    = "blog-nakom-is-eu-west-2-637423226886"
PRIVATE_BUCKET = "nakom.is-private"
EMBEDDINGS_KEY = "blog-embeddings.json"
BEDROCK_REGION = "us-east-1"
EMBED_MODEL    = "amazon.titan-embed-text-v2:0"
EMBED_DIMS     = 1024
MIN_PARA_CHARS = 80   # paragraphs shorter than this are merged with the next


# ── Embedding ─────────────────────────────────────────────────────────────────

def embed(bedrock, text: str) -> list[float]:
    response = bedrock.invoke_model(
        modelId=EMBED_MODEL,
        body=json.dumps({"inputText": text, "dimensions": EMBED_DIMS, "normalize": True}),
        contentType="application/json",
        accept="application/json",
    )
    return json.loads(response["body"].read())["embedding"]


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


def chunk_body(body: str) -> list[tuple[str, str]]:
    """
    Split a post body into (heading, paragraph_text) tuples.

    Rules:
    - Code blocks are skipped (they need surrounding context to make sense,
      and embedding raw code produces poor retrieval signal).
    - Each chunk is prefixed with the most recent H2/H3 heading so the
      embedding carries topical context.
    - Paragraphs shorter than MIN_PARA_CHARS are merged with the next.
    """
    chunks: list[tuple[str, str]] = []   # (heading, text)
    current_heading = ""
    current_lines: list[str] = []
    in_code_block = False

    def flush():
        text = " ".join(current_lines).strip()
        if text:
            chunks.append((current_heading, text))
        current_lines.clear()

    for line in body.splitlines():
        # Track code fences
        if line.startswith("```"):
            in_code_block = not in_code_block
            flush()
            continue
        if in_code_block:
            continue

        # Detect headings — update context, flush current paragraph
        heading_match = re.match(r"^(#{1,3})\s+(.+)", line)
        if heading_match:
            flush()
            level = len(heading_match.group(1))
            if level <= 3:
                current_heading = heading_match.group(2).strip()
            continue

        # Blank line = paragraph boundary
        if not line.strip():
            flush()
            continue

        current_lines.append(line.strip())

    flush()

    # Merge short paragraphs upward into the next
    merged: list[tuple[str, str]] = []
    i = 0
    while i < len(chunks):
        heading, text = chunks[i]
        if len(text) < MIN_PARA_CHARS and i + 1 < len(chunks):
            next_heading, next_text = chunks[i + 1]
            merged.append((heading, text + " " + next_text))
            i += 2
        else:
            merged.append((heading, text))
            i += 1

    return merged


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    s3      = boto3.client("s3")
    bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

    print("Listing blog posts...")
    keys = list_post_keys(s3)
    if not keys:
        print("No posts found — check bucket name and AWS profile.", file=sys.stderr)
        sys.exit(1)
    print(f"Found {len(keys)} post(s)")

    records: list[dict] = []

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

        title    = fm.get("title", slug)
        post_date = fm.get("date", "")
        post_url = fm.get("canonical", "")

        chunks = chunk_body(body)
        print(f"   {len(chunks)} chunk(s)")

        for i, (heading, para_text) in enumerate(chunks):
            # Prepend heading so the embedding carries topical context
            embed_input = f"{heading}\n\n{para_text}" if heading else para_text

            print(f"   embedding {i + 1}/{len(chunks)}...", end="\r", flush=True)
            vector = embed(bedrock, embed_input)

            records.append({
                "id":          f"{slug}:{i}",
                "post_slug":   slug,
                "post_title":  title,
                "post_date":   post_date,
                "post_url":    post_url,
                "heading":     heading,
                "text":        para_text,
                "embedding":   vector,
            })

        print(f"   {len(chunks)} chunk(s) embedded    ")

    print(f"\nTotal chunks: {len(records)}")

    payload = json.dumps(records, separators=(",", ":"))
    size_kb = len(payload.encode()) / 1024
    print(f"Payload size: {size_kb:.1f} KB")

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
