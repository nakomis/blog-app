import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

const CANONICAL_DOMAIN = 'blog.nakomis.com';
const LEGACY_DOMAIN = 'blog.nakom.is';

export interface BlogStackProps extends StackProps {
  readonly certificate: cm.ICertificate;
}

export class BlogStack extends Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: BlogStackProps) {
    super(scope, id, props);

    const { certificate } = props;

    const nakomIsZone = route53.HostedZone.fromLookup(this, 'NakomIsZone', {
      domainName: 'nakom.is',
    });

    const nakomisComZone = route53.HostedZone.fromLookup(this, 'NakomisComZone', {
      domainName: 'nakomis.com',
    });

    this.bucket = new s3.Bucket(this, 'BlogBucket', {
      bucketName: `blog-nakom-is-${this.region}-${this.account}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Redirect legacy blog.nakom.is requests to the canonical domain, preserving the path
    const legacyRedirectFunction = new cloudfront.Function(this, 'LegacyDomainRedirect', {
      functionName: 'blog-legacy-domain-redirect',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  if (event.request.headers.host.value === '${LEGACY_DOMAIN}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${CANONICAL_DOMAIN}' + event.request.uri } }
    };
  }
  return event.request;
}
`),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // Blog search Lambda Function URL domain — stored in nakom.is ChatStack SSM parameter.
    // valueFromLookup makes a real SSM API call at synth time so there is no
    // CloudFormation cross-stack reference between the two CDK apps.
    const blogSearchDomain = ssm.StringParameter.valueFromLookup(
      this, '/nakom.is/blog-search-url-domain',
    );

    this.distribution = new cloudfront.Distribution(this, 'BlogDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [{
          function: legacyRedirectFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        // Proxy search requests to the blog search Lambda Function URL.
        // The Lambda itself sets CORS headers; Function URL auth is NONE (public).
        '/api/search': {
          origin: new origins.HttpOrigin(blogSearchDomain, {
            originId: 'BlogSearchOrigin',
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      domainNames: [CANONICAL_DOMAIN, LEGACY_DOMAIN],
      certificate: certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
      comment: 'Blog distribution',
    });

    new route53.ARecord(this, 'BlogARecord', {
      zone: nakomisComZone,
      recordName: CANONICAL_DOMAIN,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });

    new route53.ARecord(this, 'BlogLegacyARecord', {
      zone: nakomIsZone,
      recordName: LEGACY_DOMAIN,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });
  }
}
