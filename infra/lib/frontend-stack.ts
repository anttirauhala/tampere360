/**
 * FrontendStack — React SPA:n jakelu (arkkitehtuuri §11).
 *
 * Yksityinen S3-bucket + CloudFront Origin Access Control + paikkamerkkisivu
 * (BucketDeployment kunnes apps/web on toteutettu Vaiheessa 4).
 *
 * WAF-lippu (wafEnabled): MVP:ssä ei omaa domainia → CloudFrontin
 * oletusdomain eikä WAF:ia (~5 €/kk). Kun domain tulee, WAF + Route 53
 * kytketään myöhemmässä vaiheessa.
 *
 * Varsinainen React-build deployataan BucketDeploymentilla Vaiheessa 4,
 * kun apps/web on toteutettu.
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import { resourceName } from './config';

const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="fi">
<head><meta charset="UTF-8"><title>Tampere360</title>
<style>body{font-family:sans-serif;margin:40px;text-align:center;background:#111;color:#eee}
h1{color:#4af}footer{margin-top:40px;font-size:0.8em;color:#666}</style>
</head>
<body><h1>Tampere360</h1>
<p>Tilannekuva tulossa pian.</p>
<p>Vaihe 4 toteuttaa React-sovelluksen.</p>
<footer>Tampere360 &copy; 2026</footer>
</body></html>`;

export interface FrontendStackProps extends cdk.StackProps {
  appContext: AppContext;
}

export class FrontendStack extends cdk.Stack {
  /** Web-bucket (myöhemmin BucketDeployment apps/web:stä). */
  public readonly webBucket: s3.Bucket;
  /** CloudFront-jakelu. */
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { appContext } = props;

    if (appContext.wafEnabled) {
      throw new Error(
        'wafEnabled=true vaatii oman domainin ja Route 53:n — toteutetaan ' +
          'myöhemmässä vaiheessa (ks. .clinerules/implementation_plan.md §14).',
      );
    }

    this.webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: resourceName(appContext.envName, 'web').concat(
        appContext.account ? `-${appContext.account}` : '',
      ),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: appContext.envName !== 'prod',
    });

    // Suojausotsakkeet (§14: CSP ja selaimen suojausotsakkeet CloudFrontissa).
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: resourceName(appContext.envName, 'security-headers'),
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
        contentSecurityPolicy: {
          // MapLibre/OSM-tiilet ja oma API sallitaan (§11, §14).
          contentSecurityPolicy:
            "default-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org https://tiles.openfreemap.org; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.amazonaws.com; worker-src 'self' blob:;",
          override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Tampere360 ${appContext.envName} -frontend`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      defaultRootObject: 'index.html',
      // SPA-reititys: 403/404 -> index.html (React Router).
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      // minimumProtocolVersion asetetaan kun oma domain + ACM-sertifikaatti
      // kytketään (myöhempi vaihe, §14). Oletusdomainilla TLS-versio on
      // CloudFrontin hallinnassa.
    });

    // Paikkamerkkisivu kunnes apps/web on toteutettu Vaiheessa 4.
    new s3deploy.BucketDeployment(this, 'PlaceholderDeployment', {
      sources: [s3deploy.Source.data('index.html', PLACEHOLDER_HTML)],
      destinationBucket: this.webBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'WebBucketName', { value: this.webBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
  }
}
