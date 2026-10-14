/**
 * Environment configuration for the blog-app CDK app (BAPP-6).
 *
 * Every environment-specific value (account, domains, bucket, stack names) is
 * resolved here from the `NPM_ENVIRONMENT` variable, following blog-pipeline's
 * `lib/config.ts`. Unlike blog-pipeline, an unset `NPM_ENVIRONMENT` means
 * `prod`: the production stacks predate this file, and a bare
 * `cdk deploy BlogStack --profile nakom.is-admin` must keep doing exactly what
 * it always has.
 */

export type DeployEnv = 'sandbox' | 'prod';

export interface EnvConfig {
  /** Short environment key — `sandbox` or `prod`. */
  deployEnv: DeployEnv;
  /** AWS account the stacks deploy into. */
  accountId: string;
  /** AWS region for everything except the CloudFront certificate. */
  region: string;
  /** Canonical public domain the blog is served from. */
  domainName: string;
  /**
   * Route53 hosted zone `domainName` lives in. Only the (stable) zone name is
   * configured — the zone ID is resolved with `HostedZone.fromLookup`.
   */
  hostedZoneName: string;
  /**
   * Legacy domain that 301-redirects to `domainName`, and its hosted zone.
   * Production only: `blog.nakom.is` lives in the production account.
   */
  legacyDomain?: { domainName: string; hostedZoneName: string };
  /** Private S3 bucket the built site and posts are synced to. */
  bucketName: string;
  /**
   * Proxy `/api/search` to the nakom.is blog-search API. Production only: the
   * API and the SSM parameters naming it live in the production account.
   */
  blogSearchApi: boolean;
  /** Prefix for SSM parameters owned by this environment. */
  ssmPrefix: string;
  /**
   * Appended to stack IDs and account-unique resource names. Empty for prod,
   * so the production stacks keep the names they were first deployed with.
   */
  suffix: string;
}

const REGION = 'eu-west-2';
const PROD_ACCOUNT = '637423226886';
const SANDBOX_ACCOUNT = '975050268859';

const CONFIG: Record<DeployEnv, EnvConfig> = {
  sandbox: {
    deployEnv: 'sandbox',
    accountId: SANDBOX_ACCOUNT,
    region: REGION,
    domainName: 'blog.sandbox.nakomis.com',
    hostedZoneName: 'sandbox.nakomis.com',
    bucketName: `blog-app-web-${SANDBOX_ACCOUNT}-sandbox`,
    blogSearchApi: false,
    ssmPrefix: '/blog/sandbox',
    suffix: '-sandbox',
  },
  prod: {
    deployEnv: 'prod',
    accountId: PROD_ACCOUNT,
    region: REGION,
    domainName: 'blog.nakomis.com',
    hostedZoneName: 'nakomis.com',
    legacyDomain: { domainName: 'blog.nakom.is', hostedZoneName: 'nakom.is' },
    // The name the bucket was created with — never change it.
    bucketName: `blog-nakom-is-${REGION}-${PROD_ACCOUNT}`,
    blogSearchApi: true,
    ssmPrefix: '/blog/prod',
    suffix: '',
  },
};

/** The GitHub repository whose Actions workflows assume the CI role. */
export const GITHUB_REPO = 'nakomis/blog-app';

/** Configuration for an explicit environment. */
export function configFor(env: DeployEnv): EnvConfig {
  return CONFIG[env];
}

/**
 * Resolve the configuration for the current deploy environment.
 *
 * @throws if `NPM_ENVIRONMENT` is set to anything but `sandbox` or `prod`.
 */
export function resolveConfig(env: string | undefined = process.env.NPM_ENVIRONMENT): EnvConfig {
  if (env === undefined || env === '') {
    return CONFIG.prod;
  }
  if (env !== 'sandbox' && env !== 'prod') {
    throw new Error(`NPM_ENVIRONMENT must be 'sandbox' or 'prod' (got: ${env})`);
  }
  return CONFIG[env];
}
