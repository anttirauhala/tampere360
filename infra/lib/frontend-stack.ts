/**
 * FrontendStack — React SPA:n jakelu (arkkitehtuuri §11).
 *
 * Yksityinen S3-bucket + CloudFront Origin Access Control + BucketDeployment,
 * joka julkaisee apps/web:n Vite-buildin (dist/) ja kirjoittaa ajonaikaisen
 * /config.json-tiedoston (API-osoite), jotta sama build toimii ympäristöittäin.
 *
 * WAF-lippu (wafEnabled): MVP:ssä ei omaa domainia → CloudFrontin
 * oletusdomain eikä WAF:ia (~5 €/kk). Kun domain tulee, WAF + Route 53
 * kytketään myöhemmässä vaiheessa.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import { resourceName } from './config';
import { buildContentSecurityPolicy } from './csp';

/** Polku apps/web:n Vite-buildiin (repo-juuresta). */
const WEB_DIST = path.join(__dirname, '..', '..', 'apps', 'web', 'dist');

export interface FrontendStackProps extends cdk.StackProps {
  appContext: AppContext;
  /** API:n juuri (ApiStackin HttpApiUrl) — kirjoitetaan /config.json-tiedostoon. */
  apiUrl: string;
}

export class FrontendStack extends cdk.Stack {
  /** Web-bucket. */
  public readonly webBucket: s3.Bucket;
  /** CloudFront-jakelu. */
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { appContext, apiUrl } = props;

    if (appContext.wafEnabled) {
      throw new Error(
        'wafEnabled=true vaatii oman domainin ja Route 53:n — toteutetaan ' +
          'myöhemmässä vaiheessa (ks. .clinerules/implementation_plan.md §14).',
      );
    }

    if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
      throw new Error(
        `Frontend-buildiä ei löytynyt: ${WEB_DIST}\n` +
          'Aja ensin: npm run build:web (tai npm run build repo-juuresta).',
      );
    }

    // Huom: apiUrl on CDK-token synteesivaiheessa, joten sitä EI saa ajaa
    // new URL():in läpi. HttpApi.apiEndpoint on muotoa
    // https://<id>.execute-api.<region>.amazonaws.com — ilman polkua ja
    // ilman loppukauttaviivaa, joten se kelpaa sellaisenaan CSP:n originiksi.
    const apiOrigin = apiUrl;

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
          // CSP rakennetaan lib/csp.ts:ssä — ks. regressiosuoja
          // infra/test/csp.test.ts (MapLibre hakee tiilet fetch:llä, joten
          // tiilien origin tarvitaan myös connect-src:hen).
          contentSecurityPolicy: buildContentSecurityPolicy({ apiOrigin }),
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
      // config.json ei saa jäädä CloudFrontin välimuistiin (API-osoite voi
      // vaihtua deployn yhteydessä).
      additionalBehaviors: {
        'config.json': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
        },
      },
      // SPA-reititys: 403/404 -> index.html (React Router).
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      // minimumProtocolVersion asetetaan kun oma domain + ACM-sertifikaatti
      // kytketään (myöhempi vaihe, §14). Oletusdomainilla TLS-versio on
      // CloudFrontin hallinnassa.
    });

    // Vite-buildi + ajonaikainen konfiguraatio (API-osoite).
    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      sources: [
        s3deploy.Source.asset(WEB_DIST),
        s3deploy.Source.data('config.json', `${JSON.stringify({ apiBaseUrl: apiUrl }, null, 2)}\n`),
      ],
      destinationBucket: this.webBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    new cdk.CfnOutput(this, 'WebBucketName', { value: this.webBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
  }
}
