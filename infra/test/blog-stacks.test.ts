import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BlogCertStack } from '../lib/blog-cert-stack';
import { BlogStack } from '../lib/blog-stack';
import { configFor, DeployEnv } from '../lib/config';

// Hosted-zone and SSM lookups resolve to CDK's dummy values in unit tests, so
// no AWS credentials are needed.
function synth(deployEnv: DeployEnv) {
  const config = configFor(deployEnv);
  const app = new cdk.App();
  const cert = new BlogCertStack(app, 'Cert', {
    env: { account: config.accountId, region: 'us-east-1' },
    config,
    crossRegionReferences: true,
  });
  const blog = new BlogStack(app, 'Blog', {
    env: { account: config.accountId, region: config.region },
    config,
    crossRegionReferences: true,
    certificate: cert.certificate,
  });
  return { cert: Template.fromStack(cert), blog: Template.fromStack(blog) };
}

function functionCode(template: Template, name: string): string {
  const fns = template.findResources('AWS::CloudFront::Function', {
    Properties: { Name: name },
  });
  return Object.values(fns)[0].Properties.FunctionCode as string;
}

describe('prod', () => {
  const { cert, blog } = synth('prod');

  test('certificate covers the canonical and legacy domains', () => {
    cert.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'blog.nakomis.com',
      SubjectAlternativeNames: ['blog.nakom.is'],
    });
  });

  test('distribution serves both domains and proxies search', () => {
    blog.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['blog.nakomis.com', 'blog.nakom.is'],
        Comment: 'Blog distribution',
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/api/search' }),
        ]),
      }),
    });
  });

  test('keeps the existing bucket and function names', () => {
    blog.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'blog-nakom-is-eu-west-2-637423226886',
    });
    expect(functionCode(blog, 'blog-legacy-domain-redirect')).toContain(
      "request.headers.host.value === 'blog.nakom.is'",
    );
    expect(functionCode(blog, 'blog-image-hotlink-protection')).toContain(
      "referer.indexOf('blog.nakom.is')",
    );
  });

  test('creates alias records for both domains', () => {
    blog.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  test('publishes the bucket and distribution to SSM', () => {
    blog.hasResourceProperties('AWS::SSM::Parameter', { Name: '/blog/prod/web/bucket-name' });
    blog.hasResourceProperties('AWS::SSM::Parameter', { Name: '/blog/prod/web/distribution-id' });
  });
});

describe('sandbox', () => {
  const { cert, blog } = synth('sandbox');

  test('certificate covers only the sandbox domain', () => {
    cert.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'blog.sandbox.nakomis.com',
      SubjectAlternativeNames: Match.absent(),
    });
  });

  test('distribution serves the sandbox domain without the search proxy', () => {
    blog.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['blog.sandbox.nakomis.com'],
        Comment: 'Blog distribution (sandbox)',
        CacheBehaviors: [Match.objectLike({ PathPattern: '/images/*' })],
      }),
    });
  });

  test('uses sandbox-specific names', () => {
    blog.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'blog-app-web-975050268859-sandbox',
    });
    const redirect = functionCode(blog, 'blog-legacy-domain-redirect-sandbox');
    expect(redirect).not.toContain('Moved Permanently');
    expect(redirect).toContain("uri = uri + '.html'");
    const hotlink = functionCode(blog, 'blog-image-hotlink-protection-sandbox');
    expect(hotlink).toContain("referer.indexOf('blog.sandbox.nakomis.com')");
    expect(hotlink).not.toContain('nakom.is');
  });

  test('creates a single alias record', () => {
    blog.resourceCountIs('AWS::Route53::RecordSet', 1);
  });
});
