#!/usr/bin/env bash
set -euo pipefail

# Ensure we run from the web/ directory regardless of where the script is invoked from
cd "$(dirname "$0")/.." || { echo "Failed to cd to web directory"; exit 1; }

# Usage: deploy.sh [prod|sandbox] — defaults to prod, as before BAPP-6.
DEPLOY_ENV="${1:-prod}"

# Use a named profile locally; in CI credentials come from OIDC
AWS_PROFILE_ARGS=()

case "${DEPLOY_ENV}" in
  prod)
    # Fixed values, so the scheduled-publish role needs no SSM access.
    BUCKET="blog-nakom-is-eu-west-2-637423226886"
    DISTRIBUTION_ID="E3OS29LWIYT9KR"
    if [ -z "${CI:-}" ]; then
      AWS_PROFILE_ARGS=(--profile nakom.is-admin)
    fi
    ;;
  sandbox)
    if [ -z "${CI:-}" ]; then
      AWS_PROFILE_ARGS=(--profile nakom.is-sandbox)
    fi
    # Published by BlogStack-sandbox, so a recreated distribution is picked up.
    BUCKET=$(aws ssm get-parameter --name /blog/sandbox/web/bucket-name \
      --query Parameter.Value --output text --region eu-west-2 "${AWS_PROFILE_ARGS[@]}")
    DISTRIBUTION_ID=$(aws ssm get-parameter --name /blog/sandbox/web/distribution-id \
      --query Parameter.Value --output text --region eu-west-2 "${AWS_PROFILE_ARGS[@]}")
    ;;
  *)
    echo "Usage: $0 [prod|sandbox]" >&2
    exit 1
    ;;
esac

echo "Deploying to ${DEPLOY_ENV}: s3://${BUCKET}, distribution ${DISTRIBUTION_ID}"

echo "Syncing web assets to S3..."
aws s3 sync dist/ "s3://${BUCKET}/" --delete "${AWS_PROFILE_ARGS[@]}"

echo "Syncing blog posts to S3..."
aws s3 sync content/blog/ "s3://${BUCKET}/posts/" --delete --exclude "*" --include "*.md" "${AWS_PROFILE_ARGS[@]}"

if [ -d content/blog/images ]; then
  echo "Syncing blog images to S3..."
  aws s3 sync content/blog/images/ "s3://${BUCKET}/images/" "${AWS_PROFILE_ARGS[@]}"
else
  echo "No local images directory, skipping image sync."
fi

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths "/*" \
  "${AWS_PROFILE_ARGS[@]}"

echo "Done."
