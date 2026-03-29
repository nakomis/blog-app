#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BlogCertStack } from '../lib/blog-cert-stack';
import { BlogStack } from '../lib/blog-stack';
import { BlogGithubStack } from '../lib/blog-github-stack';

const app = new cdk.App();
const londonEnv = { env: { account: '637423226886', region: 'eu-west-2' } };
const nvirginiaEnv = { env: { account: '637423226886', region: 'us-east-1' } };

// Deploy order: BlogCertStack → BlogStack
// IMPORTANT: BlogStack uses the same CloudFormation stack name as the
// existing stack in nakom.is ('BlogStack') for zero-downtime migration.

const certStack = new BlogCertStack(app, 'BlogCertStack', {
  ...nvirginiaEnv,
  crossRegionReferences: true,
});

const blogStack = new BlogStack(app, 'BlogStack', {
  ...londonEnv,
  crossRegionReferences: true,
  certificate: certStack.certificate,
});

new BlogGithubStack(app, 'BlogGithubStack', {
  ...londonEnv,
  bucket: blogStack.bucket,
  distribution: blogStack.distribution,
});

cdk.Tags.of(app).add('MH-Project', 'blog-app');
