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
