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

    // Two jobs in one function, because CloudFront permits only one function
    // per event type per behaviour and both have to happen on viewer-request:
    //
    //  1. Redirect legacy blog.nakom.is requests to the canonical domain,
    //     preserving the path.
    //  2. Rewrite extensionless paths to the prerendered .html file (BAPP-13).
    //     The site is prerendered to dist/<slug>.html, but readers and crawlers
    //     ask for /<slug>. Without this rewrite the S3 key misses and the
    //     request falls through to the error responses below — which is exactly
    //     the empty-shell behaviour prerendering exists to end.
    const viewerRequestFunction = new cloudfront.Function(this, 'LegacyDomainRedirect', {
      functionName: 'blog-legacy-domain-redirect',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;

  if (request.headers.host.value === '${LEGACY_DOMAIN}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${CANONICAL_DOMAIN}' + request.uri } }
    };
  }

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

    // Blog search endpoint — nakom.is API Gateway with a dedicated usage plan (20 req/day).
    // The API key is injected by CloudFront as x-api-key; it never appears in browser code.
    // Both values are read from SSM at synth time — no CloudFormation cross-stack dependency.
    const blogSearchApiDomain = ssm.StringParameter.valueFromLookup(
      this, '/nakom.is/blog-search-api-domain',
    );
    const blogSearchApiKey = ssm.StringParameter.valueFromLookup(
      this, '/nakom.is/blog-search-api-key',
    );

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    // Hotlink protection for /images/*: requests whose Referer is not one of our
    // own domains are redirected to /images/hotlink.png instead.
    // Direct loads (no Referer) are allowed — that's us browsing.
    const hotlinkProtectionFunction = new cloudfront.Function(this, 'HotlinkProtection', {
      functionName: 'blog-image-hotlink-protection',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var referer = (request.headers['referer'] || {}).value || '';

  var isOwnSite = !referer
    || referer.indexOf('blog.nakomis.com') !== -1
    || referer.indexOf('blog.nakom.is') !== -1
    || referer.indexOf('localhost') !== -1;

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
        // Proxy search requests to the nakom.is API Gateway.
        // CloudFront injects x-api-key — it never appears in browser code.
        // originPath '/prod' + CloudFront URI '/api/search' → API GW resource '/api/search'.
        '/api/search': {
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
        },
      },
      domainNames: [CANONICAL_DOMAIN, LEGACY_DOMAIN],
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
