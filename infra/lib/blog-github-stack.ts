import { Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

export interface BlogGithubStackProps extends StackProps {
  readonly bucket: s3.IBucket;
  readonly distribution: cloudfront.IDistribution;
}

export class BlogGithubStack extends Stack {
  constructor(scope: Construct, id: string, props: BlogGithubStackProps) {
    super(scope, id, props);

    const { bucket, distribution } = props;

    // Import the existing GitHub Actions OIDC provider (one per account, already
    // created by another stack).
    const githubOidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this, 'GithubOidc',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    // IAM role assumed by the blog-app scheduled-publish workflow via OIDC.
    // Scoped to the nakomis/blog-app repo only.
    const deployRole = new iam.Role(this, 'BlogDeployRole', {
      roleName: 'blog-app-github-deploy',
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidc.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': 'repo:nakomis/blog-app:*',
          },
        }
      ),
      description: 'Assumed by GitHub Actions to deploy the blog (S3 sync + CloudFront invalidation)',
    });

    bucket.grantReadWrite(deployRole);
    bucket.grantDelete(deployRole);

    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [
        `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
      ],
    }));

    // Ingestion script: write embeddings to the private bucket
    const privateBucket = s3.Bucket.fromBucketName(this, 'PrivateBucket', 'nakom.is-private');
    privateBucket.grantPut(deployRole);

    // Ingestion script: embed via Bedrock Titan Embed v2
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0'],
    }));
  }
}
