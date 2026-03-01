# blog-app

React/Vite blog frontend and AWS CDK infrastructure for [blog.nakom.is](https://blog.nakom.is).

Licenced under [CC0 1.0 Universal](LICENSE) — public domain.

## Repository layout

- `web/` — React/Vite blog frontend
- `infra/` — AWS CDK infrastructure (certificate, S3, CloudFront, Route53)

## Blog content

Blog post markdown files live in the private [`blog-content`](https://github.com/nakomis/blog-content) repo, linked as a git submodule at `web/content/`.

Clone with submodules:

```bash
git clone --recurse-submodules git@github.com:nakomis/blog-app.git
```

Or, if already cloned:

```bash
git submodule update --init
```

## Web app

```bash
cd web
npm install
npm run dev        # local dev server
npm run build      # build to web/dist/
bash scripts/deploy.sh  # sync dist/ to S3 + invalidate CloudFront
```

## Infrastructure

```bash
cd infra
npm install
AWS_PROFILE=nakom.is-admin cdk synth
AWS_PROFILE=nakom.is-admin cdk deploy BlogCertStack   # us-east-1 cert (first time only)
AWS_PROFILE=nakom.is-admin cdk deploy BlogStack       # eu-west-2 S3/CloudFront/Route53
```
