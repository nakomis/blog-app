# blog-app — Project Notes for Claude

## What this project is

A personal blog at [blog.nakom.is](https://blog.nakom.is) / [blog.nakomis.com](https://blog.nakomis.com), built as a React/Vite SPA served via CloudFront from a private S3 bucket. Blog content lives in a separate private repo (`blog-content`) linked as a git submodule at `web/content/`.

## AWS credentials

AWS SSO profile: `nakom.is-admin`

Always use `cdk` directly, never `npx cdk` — the latter loses SSO auth context.

## Deploy order (from scratch)

```
BlogCertStack (us-east-1) → BlogStack (eu-west-2) → BlogGithubStack (one-time)
```

```bash
cd infra
cdk deploy BlogCertStack --profile nakom.is-admin
cdk deploy BlogStack --profile nakom.is-admin
cdk deploy BlogGithubStack --profile nakom.is-admin
```

## Publishing a blog post

### Automated (normal flow)

Write the post in `blog-content`, set `publish_date` in frontmatter (or omit it to auto-queue), commit and push. The GitHub Actions daily cron at 08:00 UTC handles the rest.

| Intent | `publish_date` |
|--------|---------------|
| Publish now | Today's date |
| Specific date | `"YYYY-MM-DD"` |
| Queue (auto-assign) | Omit the field |

To trigger an immediate deploy: **Actions → Publish scheduled posts → Run workflow**.

### Manual deploy

All run from the blog-app root:

```bash
# 1. Pull latest blog-content submodule commits
git submodule update --remote web/content
git add web/content
git commit -m "chore: update blog-content submodule"

# 2. Build
cd web && npm run build

# 3. Deploy to S3 and invalidate CloudFront
bash scripts/deploy.sh
```

## Local development

```bash
cd web
npm install
npm run dev    # http://localhost:5173
```

## Semantic search / RAG pipeline

Blog posts are chunked and embedded so the chat assistant and search UI can do semantic retrieval.

### How it works

1. `scripts/ingest-blog.py` — run manually (or trigger via GitHub Actions) after new posts are published. It:
   - Downloads all published `.md` posts from `BLOG_BUCKET` (`blog-nakom-is-eu-west-2-637423226886`)
   - Splits each post into overlapping chunks using LangChain's `MarkdownTextSplitter` (700 char chunks, 80 char overlap)
   - Embeds each chunk via **Amazon Titan Embed v2** (`amazon.titan-embed-text-v2:0`, 1024 dims, Bedrock us-east-1)
   - Writes chunk text/metadata to the **`blog-chunks` DynamoDB table** (keyed on chunk ID, e.g. `my-post:3`)
   - Uploads a compact `blog-embeddings.json` to `nakom.is-private` S3 — contains only chunk IDs, base64-encoded Float32 embeddings, post slugs, and tags (~230 KB for 7 posts vs ~3.5 MB previously)

2. The **chat and blog-search Lambdas** (`nakom.is` repo → `lambda/chat/blog-retriever.ts`):
   - Load `blog-embeddings.json` at cold start, decoding embeddings to `Float32Array` in memory
   - Embed the user query via Titan, run cosine similarity scan (threshold 0.3, top 4, deduplicated by post)
   - Fetch the matching chunk text/metadata from DynamoDB via `BatchGetItem`

3. The **blog search UI** (wired to `/api/search` CloudFront behaviour) calls the same Lambda endpoint.

### Architecture rationale
Separating embeddings (S3) from text (DynamoDB) keeps the cold-start file small regardless of blog growth. Binary-encoding the Float32 embeddings reduces the S3 file ~60% vs JSON decimal arrays. DynamoDB cost is effectively zero at personal blog traffic levels.

### Re-running the ingest

```bash
AWS_PROFILE=nakom.is-admin python scripts/ingest-blog.py
```

Run this whenever new posts are published (if not automated via GitHub Actions).

## Google Search Console (MCP)

The `gsc` MCP server is configured in `~/.claude.json` and connects to Google Search Console via OAuth. Credentials are at `/Users/nakomis/repos/AminForou/mcp-gsc/client_secrets.json` (gitignored).

GSC properties:
- `sc-domain:nakom.is` — the live blog
- `sc-domain:sandbox.nakomis.com`

Sitemap submitted: `https://nakom.is/sitemap.xml` (submitted 2026-03-29).

## SEO

- Sitemap generated at build time and served at `/sitemap.xml`
- `robots.txt` served at `/robots.txt`
- Per-page meta tags and canonical URLs set in each post's frontmatter (`canonical` field)

## Architecture diagrams

Source: `docs/architecture/blog-app.drawio` — SVG auto-regenerated on commit by `.githooks/pre-commit`.

To activate the hook after cloning:
```bash
git config core.hooksPath .githooks
```
