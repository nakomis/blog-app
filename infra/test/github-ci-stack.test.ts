import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { GithubCiStack } from '../lib/github-ci-stack';
import { configFor, DeployEnv } from '../lib/config';

function webResources(scope: cdk.Stack, bucketName: string) {
  return {
    // A real bucket rather than an import, so this helper stack is not empty.
    webBucket: new s3.Bucket(scope, 'Bucket', { bucketName }),
    webDistribution: cloudfront.Distribution.fromDistributionAttributes(scope, 'Distribution', {
      distributionId: 'E123EXAMPLE',
      domainName: 'd123.cloudfront.net',
    }),
  };
}

function synth(deployEnv: DeployEnv, withWeb: boolean): Template {
  const config = configFor(deployEnv);
  const app = new cdk.App();
  const env = { account: config.accountId, region: config.region };
  const stack = new GithubCiStack(app, 'TestCi', {
    env,
    config,
    ...(withWeb ? webResources(new cdk.Stack(app, 'Resources', { env }), config.bucketName) : {}),
  });
  return Template.fromStack(stack);
}

function statements(template: Template): Record<string, unknown>[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies).flatMap(
    (p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[],
  );
}

describe('GithubCiStack', () => {
  test.each(['sandbox', 'prod'] as const)('names the %s role per environment', (env) => {
    synth(env, false).hasResourceProperties('AWS::IAM::Role', {
      RoleName: `nakomis-blog-app-github-ci-${env}`,
      MaxSessionDuration: 3600,
    });
  });

  test('trusts only the blog-app repo, via OIDC, for the STS audience', () => {
    synth('sandbox', true).hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Principal: {
              Federated:
                'arn:aws:iam::975050268859:oidc-provider/token.actions.githubusercontent.com',
            },
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:nakomis/blog-app:*' },
            },
          }),
        ],
      }),
    });
  });

  test('prod role may only assume the CDK bootstrap roles', () => {
    expect(statements(synth('prod', false))).toEqual([
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Resource: 'arn:aws:iam::637423226886:role/cdk-hnb659fds-*',
      },
    ]);
  });

  test('sandbox role can publish the site and read only the web parameters', () => {
    const actions = statements(synth('sandbox', true)).map((s) => s.Action);
    expect(actions).toEqual([
      'sts:AssumeRole',
      ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      'cloudfront:CreateInvalidation',
      'ssm:GetParameter',
    ]);
    synth('sandbox', true).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ssm:GetParameter',
            Resource: 'arn:aws:ssm:eu-west-2:975050268859:parameter/blog/sandbox/web/*',
          }),
        ]),
      }),
    });
  });
});
