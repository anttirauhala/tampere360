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
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import { resourceName } from './config';

export interface ApiStackProps extends cdk.StackProps {
  appContext: AppContext;
  situationsTable: dynamodb.ITable;
  sourceEventsTable: dynamodb.ITable;
  ingestionStateTable: dynamodb.ITable;
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
  /** Query-Lambda valvontaa varten. */
  public readonly queryFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { appContext, situationsTable, sourceEventsTable, ingestionStateTable } = props;

    this.queryFunction = new lambdaNodejs.NodejsFunction(this, 'QueryFunction', {
      entry: path.join(__dirname, '../../apps/api/src/handler.ts'),
      handler: 'handler',
      functionName: resourceName(appContext.envName, 'api'),
      description: 'Tampere247 query-API: /v1/situations, /v1/sources, /v1/health/sources, ...',
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
      description: 'Tampere247 query-API',
      createDefaultStage: false,
      corsPreflight: {
        // MVP: CloudFront-domain; oma domain myöhemmin (tarkennetaan §14).
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowHeaders: ['content-type', 'accept'],
        maxAge: cdk.Duration.minutes(10),
      },
    });

    // $default-stage + throttling (§14: API Gateway throttling).
    new apigwv2.HttpStage(this, 'DefaultStage', {
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

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.httpApi.url ?? '' });
  }
}
