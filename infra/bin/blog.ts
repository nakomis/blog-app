#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import { resolveConfig } from '../lib/config';
import { BlogCertStack } from '../lib/blog-cert-stack';
import { BlogStack } from '../lib/blog-stack';
import { BlogGithubStack } from '../lib/blog-github-stack';
import { GithubCiStack } from '../lib/github-ci-stack';

// NPM_ENVIRONMENT selects sandbox or prod (BAPP-6); unset means prod, so the
// existing production commands behave exactly as before.
const config = resolveConfig();
const app = new cdk.App();
const londonEnv = { env: { account: config.accountId, region: config.region } };
const nvirginiaEnv = { env: { account: config.accountId, region: 'us-east-1' } };

// Deploy order: BlogCertStack → BlogStack → BlogGithubCiStack
// IMPORTANT: in prod, BlogStack uses the same CloudFormation stack name as the
// existing stack in nakom.is ('BlogStack') for zero-downtime migration — so
// production stack IDs carry no suffix. Sandbox stacks are suffixed '-sandbox'.

const certStack = new BlogCertStack(app, `BlogCertStack${config.suffix}`, {
  ...nvirginiaEnv,
  config,
  crossRegionReferences: true,
});

const blogStack = new BlogStack(app, `BlogStack${config.suffix}`, {
  ...londonEnv,
  config,
  crossRegionReferences: true,
  certificate: certStack.certificate,
});

// The scheduled-publish role, the blog-content images role and their grants
// on production-only resources (search embeddings, Substack, alerting).
if (config.deployEnv === 'prod') {
  new BlogGithubStack(app, 'BlogGithubStack', {
    ...londonEnv,
    bucket: blogStack.bucket,
    distribution: blogStack.distribution,
  });
}

// The CI role (ci.yml). Only sandbox gets site-publish permissions: CI
// publishes the sandbox site, while the production site is still published by
// the scheduled-publish workflow, so the prod CI role only deploys the stacks.
new GithubCiStack(app, `BlogGithubCiStack${config.suffix}`, {
  ...londonEnv,
  config,
  ...(config.deployEnv === 'sandbox'
    ? { webBucket: blogStack.bucket, webDistribution: blogStack.distribution }
    : {}),
});

const { version: infraVersion } = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));
cdk.Tags.of(app).add('MH-Project', 'blog-app');
cdk.Tags.of(app).add('MH-Version', infraVersion);
