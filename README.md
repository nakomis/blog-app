# blog.nakom.is — A Personal Blog on AWS

This project is a personal blog at [blog.nakom.is](https://blog.nakom.is), built as a React/Vite single-page application served via CloudFront from a private S3 bucket. Blog post content lives in a separate private repository linked as a git submodule, keeping the infrastructure and content concerns cleanly separated.

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=blog-app)

## Table of Contents

<!-- toc -->

- [Architecture Diagram](#architecture-diagram)
- [Repository Layout](#repository-layout)
- [Blog Content](#blog-content)
- [Components](#components)
  * [Certificate Manager](#certificate-manager)
  * [S3 Bucket](#s3-bucket)
  * [CloudFront](#cloudfront)
  * [Route53](#route53)
- [Web App](#web-app)
  * [Content Pipeline](#content-pipeline)
  * [Local Development](#local-development)
  * [Deployment](#deployment)
- [Infrastructure](#infrastructure)
- [Environments](#environments)
- [CI/CD](#cicd)
  * [First deployment](#first-deployment)
- [SEO](#seo)
- [Architecture Diagrams](#architecture-diagrams)

<!-- tocstop -->

## Architecture Diagram

![Architecture](docs/architecture/blog-app.svg)

## Repository Layout

- `web/` — React/Vite blog frontend (TypeScript)
- `web/content/` — git submodule pointing to the private [blog-content](https://github.com/nakomis/blog-content) repo
- `web/scripts/` — build and deployment scripts
- `infra/` — AWS CDK infrastructure (TypeScript)
- `docs/architecture/` — architecture diagram source (draw.io) and exported SVG
- `.githooks/` — git hooks (SVG auto-generation on commit)

## Blog Content

Blog post markdown files live in the private [`blog-content`](https://github.com/nakomis/blog-content) repo, linked as a git submodule at `web/content/`. This keeps post content separate from the public infrastructure code.

Clone with submodules:

```bash
git clone --recurse-submodules git@github.com:nakomis/blog-app.git
```

Or, if already cloned:

```bash
git submodule update --init
```

## Components

### Certificate Manager

The [BlogCertStack](infra/lib/blog-cert-stack.ts) creates an ACM certificate covering `blog.nakomis.com` (primary) and `blog.nakom.is` (SAN) in `us-east-1`, as CloudFront requires certificates to be in that region. DNS validation is used, automatically creating the validation records in the `nakomis.com` and `nakom.is` Route53 hosted zones respectively.

This stack must be deployed before the main BlogStack since the certificate ARN is passed as a cross-stack reference.

### S3 Bucket

The [BlogStack](infra/lib/blog-stack.ts) creates a private S3 bucket (`blog-nakom-is-eu-west-2-<account>`) to store the built web assets. The bucket blocks all public access; objects are served exclusively via CloudFront using Origin Access Control (OAC), so the bucket never needs a public-read policy.

The deployment script syncs two things to the bucket:
- `web/dist/` — the compiled React application (JS, CSS, HTML, images)
- `web/content/blog/` → `s3://<bucket>/posts/` — raw markdown files, served at runtime so the app can fetch post content without a rebuild

### CloudFront

The CloudFront distribution in [BlogStack](infra/lib/blog-stack.ts) sits in front of the S3 bucket and handles:

- **HTTPS enforcement** — all HTTP requests are redirected to HTTPS
- **Legacy redirect** — requests to `blog.nakom.is` are 301-redirected to `blog.nakomis.com`, preserving the path
- **SPA routing** — 403 and 404 responses from S3 are rewritten to serve `index.html` with a 200 status, allowing React Router to handle client-side routes
- **Compression** — assets are gzip/brotli compressed
- **Caching** — the `CACHING_OPTIMIZED` managed cache policy is used for all behaviours

The ACM certificate is attached to the distribution, covering both `blog.nakomis.com` and `blog.nakom.is`.

### Route53

DNS A alias records are created for both domains:
- `blog.nakomis.com` in the `nakomis.com` hosted zone
- `blog.nakom.is` in the `nakom.is` hosted zone

Both point at the same CloudFront distribution. The hosted zones are looked up by domain name rather than imported by ID, so no manual configuration is required.

## Web App

### Content Pipeline

At build time, [`web/scripts/buildContent.ts`](web/scripts/buildContent.ts) reads all markdown files from `web/content/blog/`, processes them through a unified/remark/rehype pipeline (with frontmatter extraction and syntax highlighting), and writes a generated TypeScript file (`web/src/content.generated.ts`) containing all post HTML and metadata as a typed constant. This file is imported directly by the React app, so no runtime markdown parsing is needed for the post content itself.

At runtime, the app also fetches raw markdown files from S3 (`/posts/<slug>.md`) — this allows the post list and content to reflect whatever is synced to S3, including posts added after the last frontend build.

### Local Development

```bash
cd web
pnpm install
pnpm run dev       # local dev server on http://localhost:5173
```

### Deployment

```bash
cd web
pnpm run build                   # build to web/dist/
bash scripts/deploy.sh           # sync dist/ and content/blog/ to S3, invalidate CloudFront
```

`deploy.sh` publishes to production by default (`bash scripts/deploy.sh sandbox` for sandbox) and uses the `nakom.is-admin` AWS profile locally (`nakom.is-sandbox` for sandbox). In GitHub Actions, credentials come from OIDC (no stored secrets).

### Scheduled publishing

A daily GitHub Actions workflow (`.github/workflows/scheduled-publish.yml`) runs at 08:00 UTC. It pulls the latest blog-content submodule, builds, and deploys. Posts with a `publish_date` in the past or present are included; future-dated posts are skipped.

To trigger a deploy immediately (e.g. after a manual content change): **Actions → Publish scheduled posts → Run workflow**.

## Infrastructure

Four CDK stacks. `NPM_ENVIRONMENT` selects the environment (`sandbox` or `prod`); **unset means prod**, so the production commands below behave exactly as they always have. Production stack names carry no suffix (`BlogStack` keeps the name it was migrated from nakom.is with); sandbox stacks are suffixed `-sandbox`.

| Stack | Region | Contents |
|---|---|---|
| `BlogCertStack[-sandbox]` | us-east-1 | ACM certificate for CloudFront |
| `BlogStack[-sandbox]` | eu-west-2 | S3 bucket, CloudFront, Route53, `/blog/<env>/web/*` SSM parameters |
| `BlogGithubStack` | eu-west-2 | Prod only: the scheduled-publish role (`blog-app-github-deploy`) and the blog-content images role |
| `BlogGithubCiStack[-sandbox]` | eu-west-2 | The CI role (`nakomis-blog-app-github-ci-<env>`) assumed by `ci.yml` via OIDC |

Production, deployed by hand as before:

```bash
cd infra
pnpm install
cdk deploy BlogCertStack --profile nakom.is-admin     # us-east-1 cert (first time only)
cdk deploy BlogStack --profile nakom.is-admin         # eu-west-2 S3/CloudFront/Route53
cdk deploy BlogGithubStack --profile nakom.is-admin   # scheduled-publish deploy role (one-time setup)
cdk deploy BlogGithubCiStack --profile nakom.is-admin # CI role (one-time setup)
```

Sandbox, everything at once:

```bash
cd infra
NPM_ENVIRONMENT=sandbox cdk deploy --all --profile nakom.is-sandbox
```

The GitHub stacks import the existing `token.actions.githubusercontent.com` OIDC provider rather than creating a new one (only one is allowed per AWS account).

Infra checks: `pnpm run typecheck` and `pnpm test` (Jest, 70% coverage minimum).

## Environments

| Environment | Domain | AWS account | Site published by |
|---|---|---|---|
| Sandbox | `blog.sandbox.nakomis.com` | `975050268859` (`nakom.is-sandbox`) | `ci.yml`, on every push to `main` |
| Production | `blog.nakomis.com` (+ `blog.nakom.is` redirect) | `637423226886` (`nakom.is-admin`) | `scheduled-publish.yml`, daily |

Sandbox is a deliberately smaller copy of production: no `blog.nakom.is` legacy domain, and no `/api/search` proxy (the nakom.is search API and its parameters live in the production account), so search returns the 404 page there. The ingest, Substack and Bluesky jobs remain production-only. Canonical URLs on sandbox pages still point at `blog.nakomis.com`, so the sandbox copy does not compete with production in search results.

`web/scripts/deploy.sh [prod|sandbox]` publishes the built site; it defaults to `prod`. For sandbox it reads the bucket and distribution from `/blog/sandbox/web/*` in SSM.

## CI/CD

`.github/workflows/ci.yml`, following blog-pipeline's:

| Trigger | Jobs |
|---|---|
| Pull request, push to `main` | Web: lint (ESLint), type-check, Vitest, build · Scripts: Python `unittest` · Infra: type-check, Jest · CDK synth for sandbox (assumes the sandbox CI role, as the lookups need AWS) |
| Push to `main`, or a manual run | Deploy — sandbox: `cdk deploy --all` to sandbox, then build with the latest blog-content and publish to `blog.sandbox.nakomis.com`. Runs only once every check above passes. |
| Manual run on `main` with **promote to production** ticked | Deploy — production: `cdk deploy --all` for prod, after the sandbox deploy succeeds. Infrastructure only: the production site is still published by the scheduled-publish workflow. |

To promote: **Actions → CI → Run workflow**, branch `main`, tick **promote to production**. The `production` GitHub environment should require Martin's approval as a second gate.

The CI roles trust `repo:nakomis/blog-app:*` with the `sts.amazonaws.com` audience, the same trust policy shape as blog-pipeline's. Each role may assume the CDK bootstrap roles (`cdk-hnb659fds-*`); the sandbox role may also sync the sandbox bucket, invalidate the sandbox distribution and read `/blog/sandbox/web/*`.

### First deployment

The CI roles are themselves created by CDK, so the first deployment cannot run through CI. With AWS credentials, once:

1. Make sure both sandbox regions are CDK-bootstrapped (already done for blog-pipeline; harmless to repeat):
   ```bash
   cdk bootstrap aws://975050268859/eu-west-2 aws://975050268859/us-east-1 --profile nakom.is-sandbox
   ```
2. Deploy every sandbox stack — certificate, site and CI role:
   ```bash
   cd infra && pnpm install
   NPM_ENVIRONMENT=sandbox cdk deploy --all --profile nakom.is-sandbox
   ```
3. Create the production CI role only — the live stacks are not touched:
   ```bash
   cdk deploy BlogGithubCiStack --profile nakom.is-admin
   ```
   (`cdk diff BlogStack --profile nakom.is-admin` should show only the two new `/blog/prod/web/*` SSM parameters; they arrive with the next production deploy.)
4. In GitHub (**Settings → Environments**), create `sandbox` and `production`, and add Martin as a required reviewer on `production`. Check that `BLOG_CONTENT_DEPLOY_KEY` is a repository secret, not scoped to another environment, so the sandbox job can read it.
5. Re-run CI on `main` (**Actions → CI → Run workflow**) and check <https://blog.sandbox.nakomis.com>.
6. Optionally, make the CI checks required in the `main` branch protection rule.

After that, every push to `main` deploys sandbox by itself. `cdk.context.json` stays gitignored: it holds the search API key resolved at synth time.

## SEO

The blog generates a sitemap at build time (`/sitemap.xml`) and serves a `robots.txt`. Each post sets its own meta tags and canonical URL via the `canonical` frontmatter field.

The sitemap is submitted to Google Search Console under `sc-domain:nakom.is`. GSC is accessible via the [mcp-gsc](https://github.com/AminForou/mcp-gsc) MCP server, configured in `~/.claude.json` for use with Claude Code.

## Architecture Diagrams

`docs/architecture/blog-app.drawio` is the source for the diagram at the top of this README. The SVG is auto-generated on commit by the pre-commit hook in `.githooks/pre-commit`.

To activate the hook after cloning:

```bash
git config core.hooksPath .githooks
```

To regenerate the SVG manually:

```bash
/Applications/draw.io.app/Contents/MacOS/draw.io -x docs/architecture/blog-app.drawio -f svg -s 1 docs/architecture/blog-app.svg
```

Requires the [draw.io desktop app](https://github.com/jgraph/drawio-desktop/releases) to be installed at `/Applications/draw.io.app`.

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=blog-app)
