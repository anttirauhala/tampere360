/**
 * ApiStack — backend-rajapinta (arkkitehtuuri §10).
 *
 * API Gateway HTTP API (kevyempi kuin REST API) + query-Lambda → DynamoDB.
 * Cursor-pohjainen sivutus (ei offset). MVP:ssä React pollaa 30–60 s välein.
 *
 * Reitit:
 *   GET /v1/situations          (suodattimet + cursor)
 *   GET /v1/situations/{id}
 *   GET /v1/map
 *   GET /v1/categories
 *   GET /v1/sources
 *   GET /v1/health/sources
 */

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import type { AppContext, DomainConfig } from './config';
import { frontendOrigins, resourceName } from './config';

export interface ApiStackProps extends cdk.StackProps {
  appContext: AppContext;
  situationsTable: dynamodb.ITable;
  sourceEventsTable: dynamodb.ITable;
  ingestionStateTable: dynamodb.ITable;
  /** Oman domainin konfiguraatio (prod): API saa oman osoitteen `api.<domain>`. */
  domain?: DomainConfig;
}

const API_ROUTES = [
  '/v1/situations',
  '/v1/situations/{id}',
  '/v1/map',
  '/v1/categories',
  '/v1/sources',
  '/v1/health/sources',
];

export class ApiStack extends cdk.Stack {
  /** HTTP API (url-ominaisuus) frontendin ja testausta varten. */
  public readonly httpApi: apigwv2.HttpApi;
  /** API:n juuri (esim. https://xxx.execute-api.eu-north-1.amazonaws.com tai oma domain). */
  public readonly httpApiUrl: string;
  /** Query-Lambda valvontaa varten. */
  public readonly queryFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { appContext, situationsTable, sourceEventsTable, ingestionStateTable, domain } = props;

    this.queryFunction = new lambdaNodejs.NodejsFunction(this, 'QueryFunction', {
      entry: path.join(__dirname, '../../apps/api/src/handler.ts'),
      handler: 'handler',
      functionName: resourceName(appContext.envName, 'api'),
      description: 'Tampere360 query-API: /v1/situations, /v1/sources, /v1/health/sources, ...',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        ENVIRONMENT: appContext.envName,
        SITUATIONS_TABLE_NAME: situationsTable.tableName,
        SOURCE_EVENTS_TABLE_NAME: sourceEventsTable.tableName,
        INGESTION_STATE_TABLE_NAME: ingestionStateTable.tableName,
        LOG_LEVEL: 'INFO',
      },
    });

    situationsTable.grantReadData(this.queryFunction);
    sourceEventsTable.grantReadData(this.queryFunction);
    ingestionStateTable.grantReadData(this.queryFunction);

    const integration = new apigwv2Integrations.HttpLambdaIntegration(
      'QueryIntegration',
      this.queryFunction,
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: resourceName(appContext.envName, 'api'),
      description: 'Tampere360 query-API',
      createDefaultStage: false,
      corsPreflight: {
        // Oma domain (prod) → sallitaan vain frontendin originit. Ilman
        // domainia (dev/test) sallitaan kaikki, koska CloudFrontin
        // oletusdomain voi vaihtua deployn yhteydessä.
        allowOrigins: domain ? frontendOrigins(domain) : ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowHeaders: ['content-type', 'accept'],
        maxAge: cdk.Duration.minutes(10),
      },
    });

    // $default-stage + throttling (§14: API Gateway throttling).
    const defaultStage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 100, burstLimit: 200 },
    });

    for (const route of API_ROUTES) {
      this.httpApi.addRoutes({
        path: route,
        methods: [apigwv2.HttpMethod.GET],
        integration,
      });
    }

    // Oma domain (prod): api.<domain>. Alueellinen ACM-sertifikaatti luodaan
    // tässä stackissa (eu-north-1), koska API Gateway ei hyväksy
    // CloudFront-sertifikaattia (us-east-1). DNS-validointi tehdään Route 53:een.
    if (domain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: domain.hostedZoneId,
        zoneName: domain.hostedZoneName,
      });

      const apiCertificate = new acm.Certificate(this, 'ApiCertificate', {
        domainName: domain.apiDomainName,
        validation: acm.CertificateValidation.fromDns(zone),
      });

      const apiDomainName = new apigwv2.DomainName(this, 'ApiDomainName', {
        domainName: domain.apiDomainName,
        certificate: apiCertificate,
        securityPolicy: apigwv2.SecurityPolicy.TLS_1_2,
      });

      const mapping = new apigwv2.ApiMapping(this, 'ApiMapping', {
        api: this.httpApi,
        domainName: apiDomainName,
        stage: defaultStage,
      });
      // API-mäppäys edellyttää, että $default-stage on deployattu.
      mapping.node.addDependency(defaultStage.node.defaultChild as cdk.CfnResource);

      const target = route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayv2DomainProperties(
          apiDomainName.regionalDomainName,
          apiDomainName.regionalHostedZoneId,
        ),
      );
      new route53.ARecord(this, 'ApiARecord', {
        zone,
        recordName: domain.apiDomainName,
        target,
      });
      new route53.AaaaRecord(this, 'ApiAaaaRecord', {
        zone,
        recordName: domain.apiDomainName,
        target,
      });

      this.httpApiUrl = `https://${domain.apiDomainName}`;
      new cdk.CfnOutput(this, 'ApiCustomUrl', {
        value: this.httpApiUrl,
        description: 'API:n julkinen osoite (oma domain)',
      });
    } else {
      this.httpApiUrl = this.httpApi.apiEndpoint;
    }

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    if (domain) {
      new cdk.CfnOutput(this, 'ApiDomain', { value: domain.apiDomainName });
    }
  }
}
