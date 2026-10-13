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
cd web && pnpm run build

# 3. Deploy to S3 and invalidate CloudFront
bash web/scripts/deploy.sh
```

**Important:** always update the submodule before running `deploy.sh`. The deploy script uses `--delete` when syncing posts to S3, so a stale submodule will wipe any posts that aren't checked out locally.

## Local development

```bash
cd web
pnpm install
pnpm run dev   # http://localhost:5173
```

## Amazon affiliate links (BAPP-16)

Posts may link products on Amazon UK with Martin's Associates tag. How it works:

- `web/src/utils/amazonLinks.ts` + `rehypeAmazonAffiliate.ts` (a rehype plugin in `markdownPipeline.ts`): every amazon.co.uk link in a post is rewritten to `https://www.amazon.co.uk/dp/<ASIN>?tag=<id>` (other UK pages keep their path and gain the tag), with `rel="sponsored nofollow noopener"` and `target="_blank"`. The tag is the post's `amazon_tracking_id` frontmatter, falling back to the store id `nakomis-21` with a build warning.
- Build errors (fatal only for posts about to go live, so a draft cannot block publication): a tracking id that isn't `[a-z0-9-]+-21`, or an unresolved short link (`link.amazon`, `amzn.to`...), which the build can't rewrite. Short links are resolved at authoring time by `blog-content/scripts/resolve-amazon-links.py`. Links to other marketplaces (amazon.com...) are left alone with a warning.
- Posts with affiliate links show the disclosure line at the top (`BlogPost.tsx`); `/affiliate-disclosure` is the site-wide page, linked from the footer.
- Substack: the mirror is emailed, and Associates links aren't allowed in emails, so `scripts/substack-sync.py` untags every Amazon link (`scripts/amazon_links.py`) and refuses to mirror a short link.
- Tests: `cd web && pnpm test` (Vitest) and `python3 -m unittest discover -s scripts -p 'test_*.py'`; both run on PRs (`.github/workflows/test.yml`).

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
   - Embed the user query via Titan, run cosine similarity scan (threshold 0.22, top 4, deduplicated by post)
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
