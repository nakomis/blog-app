#!/usr/bin/env bash
set -euo pipefail

BUCKET="blog-nakom-is-eu-west-2-637423226886"
DISTRIBUTION_ID="E1YIX46VV6J06Y"
PROFILE="nakom.is-admin"

echo "Syncing web assets to S3..."
aws s3 sync dist/ "s3://${BUCKET}/" --delete --profile "${PROFILE}"

echo "Syncing blog posts to S3..."
aws s3 sync content/blog/ "s3://${BUCKET}/posts/" --delete --include "*.md" --profile "${PROFILE}"

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths "/*" \
  --profile "${PROFILE}"

echo "Done."
