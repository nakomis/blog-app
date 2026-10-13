import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface BlogStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly certificate: cm.ICertificate;
}

export class BlogStack extends Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: BlogStackProps) {
    super(scope, id, props);

    const { config, certificate } = props;
    const { domainName, legacyDomain, suffix } = config;

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: config.hostedZoneName,
    });

    this.bucket = new s3.Bucket(this, 'BlogBucket', {
      bucketName: config.bucketName,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Two jobs in one function, because CloudFront permits only one function
    // per event type per behaviour and both have to happen on viewer-request:
    //
    //  1. Redirect legacy blog.nakom.is requests to the canonical domain,
    //     preserving the path (production only — sandbox has no legacy domain).
    //  2. Rewrite extensionless paths to the prerendered .html file (BAPP-13).
    //     The site is prerendered to dist/<slug>.html, but readers and crawlers
    //     ask for /<slug>. Without this rewrite the S3 key misses and the
    //     request falls through to the error responses below — which is exactly
    //     the empty-shell behaviour prerendering exists to end.
    const legacyRedirect = legacyDomain ? `
  if (request.headers.host.value === '${legacyDomain.domainName}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${domainName}' + request.uri } }
    };
  }
` : '';
    const viewerRequestFunction = new cloudfront.Function(this, 'LegacyDomainRedirect', {
      functionName: `blog-legacy-domain-redirect${suffix}`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
${legacyRedirect}
  var uri = request.uri;

  // Leave the root alone — defaultRootObject already maps it to index.html.
  if (uri === '/') {
    return request;
  }

  // Serve /<slug>/ the same page as /<slug>, by rewrite rather than redirect.
  // A 301 here would be tidier for canonicalisation but would drop the query
  // string — CloudFront does not carry it into the location header — and that
  // silently eats utm_* and gclid on any ad click that lands on the slashed
  // form. The <link rel="canonical"> emitted on every prerendered page is the
  // mechanism for telling search engines which URL is the real one.
  if (uri.endsWith('/')) {
    uri = uri.slice(0, -1);
  }

  // Anything with a file extension in its last segment is a real asset —
  // /assets/index-abc123.js, /posts/some-post.md, /favicon.ico — and is
  // fetched from S3 unchanged.
  var lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    uri = uri + '.html';
  }

  request.uri = uri;
  return request;
}
`),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    // Hotlink protection for /images/*: requests whose Referer is not one of our
    // own domains are redirected to /images/hotlink.png instead.
    // Direct loads (no Referer) are allowed — that's us browsing.
    const ownSiteChecks = [
      '!referer',
      ...[domainName, legacyDomain?.domainName, 'localhost']
        .filter((host): host is string => !!host)
        .map((host) => `referer.indexOf('${host}') !== -1`),
    ].join('\n    || ');
    const hotlinkProtectionFunction = new cloudfront.Function(this, 'HotlinkProtection', {
      functionName: `blog-image-hotlink-protection${suffix}`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var referer = (request.headers['referer'] || {}).value || '';

  var isOwnSite = ${ownSiteChecks};

  // Pass through the hotlink image itself to avoid an infinite redirect loop
  if (!isOwnSite && request.uri !== '/images/hotlink.png') {
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: { location: { value: '/images/hotlink.png' } }
    };
  }

  return request;
}
`),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // Blog search endpoint — nakom.is API Gateway with a dedicated usage plan (20 req/day).
    // The API key is injected by CloudFront as x-api-key; it never appears in browser code.
    // Both values are read from SSM at synth time — no CloudFormation cross-stack dependency.
    // Production only: the API and its parameters live in the production account,
    // so /api/search on sandbox falls through to the 404 page.
    const searchBehaviour: Record<string, cloudfront.BehaviorOptions> = {};
    if (config.blogSearchApi) {
      const blogSearchApiDomain = ssm.StringParameter.valueFromLookup(
        this, '/nakom.is/blog-search-api-domain',
      );
      const blogSearchApiKey = ssm.StringParameter.valueFromLookup(
        this, '/nakom.is/blog-search-api-key',
      );
      // originPath '/prod' + CloudFront URI '/api/search' → API GW resource '/api/search'.
      searchBehaviour['/api/search'] = {
        origin: new origins.HttpOrigin(blogSearchApiDomain, {
          originId: 'BlogSearchOrigin',
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          originPath: '/prod',
          customHeaders: { 'x-api-key': blogSearchApiKey },
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      };
    }

    this.distribution = new cloudfront.Distribution(this, 'BlogDistribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [{
          function: viewerRequestFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        // Serve blog post images directly from S3 with aggressive caching.
        '/images/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          functionAssociations: [{
            function: hotlinkProtectionFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          }],
        },
        ...searchBehaviour,
      },
      domainNames: legacyDomain ? [domainName, legacyDomain.domainName] : [domainName],
      certificate: certificate,
      defaultRootObject: 'index.html',
      // Every route is prerendered to its own HTML file (BAPP-13), so a miss is
      // now a genuine miss and says so.
      //
      // This previously mapped both statuses to /index.html with status **200**
      // — necessary when the SPA had to boot and route client-side, but a soft
      // 404: every typo URL looked to a crawler like a valid page carrying thin
      // content, which Google treats as a quality problem across the site.
      //
      // 403 is listed as well as 404 because the bucket is private behind OAC
      // and grants only s3:GetObject — with no s3:ListBucket, S3 answers a
      // missing key with AccessDenied rather than NoSuchKey.
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(5),
        },
      ],
      comment: config.deployEnv === 'prod' ? 'Blog distribution' : `Blog distribution (${config.deployEnv})`,
    });

    new route53.ARecord(this, 'BlogARecord', {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });

    if (legacyDomain) {
      const legacyZone = route53.HostedZone.fromLookup(this, 'LegacyZone', {
        domainName: legacyDomain.hostedZoneName,
      });
      new route53.ARecord(this, 'BlogLegacyARecord', {
        zone: legacyZone,
        recordName: legacyDomain.domainName,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.distribution)
        ),
      });
    }

    // Where CI's site publish finds the bucket and distribution (BAPP-6),
    // following blog-pipeline's `<prefix>/web/*` parameters.
    new ssm.StringParameter(this, 'BucketNameParam', {
      parameterName: `${config.ssmPrefix}/web/bucket-name`,
      stringValue: this.bucket.bucketName,
    });
    new ssm.StringParameter(this, 'DistributionIdParam', {
      parameterName: `${config.ssmPrefix}/web/distribution-id`,
      stringValue: this.distribution.distributionId,
    });
  }
}
