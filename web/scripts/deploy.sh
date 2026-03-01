#!/usr/bin/env bash
set -euo pipefail

BUCKET="blog-nakom-is-eu-west-2-637423226886"
DISTRIBUTION_ID="E1YIX46VV6J06Y"
PROFILE="nakom.is-admin"

echo "Syncing to S3..."
aws s3 sync dist/ "s3://${BUCKET}/" --delete --profile "${PROFILE}"

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths "/*" \
  --profile "${PROFILE}"

echo "Done."
