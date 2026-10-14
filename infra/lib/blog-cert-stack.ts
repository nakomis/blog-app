import * as cdk from 'aws-cdk-lib';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface BlogCertStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
}

/**
 * ACM certificate for the blog's CloudFront distribution — deployed to
 * us-east-1, as CloudFront requires. Covers the canonical domain, plus the
 * legacy domain as a SAN in production.
 */
export class BlogCertStack extends cdk.Stack {
  readonly certificate: cm.Certificate;

  constructor(scope: Construct, id: string, props: BlogCertStackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: config.hostedZoneName,
    });
    const zones: Record<string, route53.IHostedZone> = { [config.domainName]: zone };

    if (config.legacyDomain) {
      zones[config.legacyDomain.domainName] = route53.HostedZone.fromLookup(this, 'LegacyZone', {
        domainName: config.legacyDomain.hostedZoneName,
      });
    }

    this.certificate = new cm.Certificate(this, 'BlogCert', {
      domainName: config.domainName,
      subjectAlternativeNames: config.legacyDomain ? [config.legacyDomain.domainName] : undefined,
      validation: cm.CertificateValidation.fromDnsMultiZone(zones),
    });
  }
}
