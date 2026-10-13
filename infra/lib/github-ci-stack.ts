import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvConfig, GITHUB_REPO } from './config';

export interface GithubCiStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  /** Site bucket — grants the CI role permission to sync the built site. */
  readonly webBucket?: s3.IBucket;
  /** CloudFront distribution — grants the CI role permission to invalidate it. */
  readonly webDistribution?: cloudfront.IDistribution;
}

/**
 * IAM role assumed by the CI workflow (`.github/workflows/ci.yml`), via
 * GitHub OIDC, to synth and deploy the CDK app (BAPP-6). Mirrors
 * blog-pipeline's `GithubCiStack`.
 *
 * This is separate from `BlogGithubStack`'s `blog-app-github-deploy` role,
 * which the scheduled-publish workflow uses for the production site, search
 * ingestion and the Substack mirror, and which is left as it is.
 *
 * The OIDC provider for `token.actions.githubusercontent.com` already exists
 * in both the sandbox and production accounts, so it is imported rather than
 * created here.
 */
export class GithubCiStack extends cdk.Stack {
  public readonly ciRole: iam.IRole;

  constructor(scope: Construct, id: string, props: GithubCiStackProps) {
    super(scope, id, props);
    const { config, webBucket, webDistribution } = props;

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidcProvider',
      `arn:aws:iam::${config.accountId}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const ciRole = new iam.Role(this, 'GithubCiRole', {
      roleName: `nakomis-blog-app-github-ci-${config.deployEnv}`,
      description: `GitHub Actions deploy role for blog-app (${config.deployEnv})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:*`,
        },
      }),
    });

    // `cdk synth` (lookups) and `cdk deploy` work by assuming the CDK bootstrap
    // roles; the CI role only needs permission to do that.
    ciRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${config.accountId}:role/cdk-hnb659fds-*`],
      }),
    );

    // Publishing the site: sync the build to the bucket, invalidate the
    // CloudFront cache, and read the SSM parameters naming both. Scoped to
    // `<prefix>/web/*` — the same prefix holds the Substack and Bluesky secrets
    // in production, which CI must never read.
    if (webBucket && webDistribution) {
      ciRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
          resources: [webBucket.bucketArn, `${webBucket.bucketArn}/*`],
        }),
      );
      ciRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::${config.accountId}:distribution/${webDistribution.distributionId}`,
          ],
        }),
      );
      ciRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${config.region}:${config.accountId}:parameter${config.ssmPrefix}/web/*`,
          ],
        }),
      );
    }

    this.ciRole = ciRole;

    new cdk.CfnOutput(this, 'GithubCiRoleArn', {
      value: ciRole.roleArn,
      description: 'IAM role ARN assumed by GitHub Actions for deployment',
    });
  }
}
