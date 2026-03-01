import * as cdk from 'aws-cdk-lib';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class BlogCertStack extends cdk.Stack {
  readonly certificate: cm.Certificate;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const nakomIsZone = route53.HostedZone.fromLookup(this, 'NakomIsZone', {
      domainName: 'nakom.is',
    });

    this.certificate = new cm.Certificate(this, 'BlogCert', {
      domainName: 'blog.nakom.is',
      validation: cm.CertificateValidation.fromDns(nakomIsZone),
    });
  }
}
