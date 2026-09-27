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
 *   GET /v1/vehicles?mode=TRAM|BUS  (oma Lambda, ks. §27)
 *   GET /v1/stops                   (pysäkkirekisteri, oma Lambda, ks. §28)
 *   GET /v1/stops/{stopId}/departures
 */

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import type { AppContext, DomainConfig } from './config';
import {
  API_THROTTLE,
  GTFS_STOPS_CACHE_MS,
  GTFS_STOPS_STALE_MAX_MS,
  GTFS_STOPS_TIMEOUT_MS,
  GTFS_STOPS_URL,
  QUERY_RESERVED_CONCURRENCY,
  STOP_CACHE_MAX_ENTRIES,
  STOP_CACHE_MS,
  STOP_DEPARTURE_LIMIT,
  STOP_PREVIEW_MINUTES,
  STOP_RESERVED_CONCURRENCY,
  STOP_STALE_MAX_MS,
  STOP_UPSTREAM_TIMEOUT_MS,
  VEHICLE_CACHE_MS,
  VEHICLE_MAX_AGE_MINUTES,
  VEHICLE_RESERVED_CONCURRENCY,
  VEHICLE_STALE_MAX_MS,
  VEHICLE_UPSTREAM_TIMEOUT_MS,
  frontendOrigins,
  resourceName,
} from './config';

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

/**
 * Ajoneuvoreitit: sama origin ja CORS kuin muilla, mutta oma Lambda ja oma
 * varattu concurrency (ks. config.ts VEHICLE_*).
 */
const VEHICLE_ROUTES = ['/v1/vehicles'];

/**
 * Pysäkkireitit (§28): staattinen pysäkkirekisteri ja yhden pysäkin
 * reaaliaikaiset lähdöt. Sama Lambda palvelee molempia, koska niillä on sama
 * konfiguraatio (SSM-avain) ja ne liittyvät samaan domain-käsitteeseen —
 * välimuistit ovat silti erilliset (ks. apps/stops/src/handler.ts).
 */
const STOP_ROUTES = ['/v1/stops', '/v1/stops/{stopId}/departures'];

export class ApiStack extends cdk.Stack {
  /** HTTP API (url-ominaisuus) frontendin ja testausta varten. */
  public readonly httpApi: apigwv2.HttpApi;
  /** API:n juuri (esim. https://xxx.execute-api.eu-north-1.amazonaws.com tai oma domain). */
  public readonly httpApiUrl: string;
  /** Query-Lambda valvontaa varten. */
  public readonly queryFunction: lambdaNodejs.NodejsFunction;
  /** Ajoneuvosijainnit-Lambda valvontaa varten (§27). */
  public readonly vehiclesFunction: lambdaNodejs.NodejsFunction;
  /** Pysäkit ja pysäkkimonitori -Lambda valvontaa varten (§28). */
  public readonly stopsFunction: lambdaNodejs.NodejsFunction;

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
      // Kustannuskatto: varattu concurrency rajaa sekä Lambda-aikaa että
      // DynamoDB-lukujen polttonopeutta (ks. config.ts).
      reservedConcurrentExecutions: QUERY_RESERVED_CONCURRENCY,
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

    // --- Ajoneuvosijainnit (§27) -------------------------------------------------
    // Hakee Waltti SIRI VM:ltä (Basic-auth) ja palauttaa kevyen GeoJSONin.
    // Ei DynamoDB-käyttöä: ajoneuvot ovat hetkellistä dataa.
    this.vehiclesFunction = new lambdaNodejs.NodejsFunction(this, 'VehiclesFunction', {
      entry: path.join(__dirname, '../../apps/vehicle-positions/src/handler.ts'),
      handler: 'handler',
      functionName: resourceName(appContext.envName, 'vehicles'),
      description: 'Tampere360: joukkoliikenteen ajoneuvosijainnit (Nysse / Waltti SIRI VM)',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      // Kustannuskatto: ks. config.ts VEHICLE_RESERVED_CONCURRENCY.
      reservedConcurrentExecutions: VEHICLE_RESERVED_CONCURRENCY,
      environment: {
        ENVIRONMENT: appContext.envName,
        SSM_API_KEY_PATH: `/tampere360/${appContext.envName}/sources/nysse/api-key`,
        VEHICLE_CACHE_MS: String(VEHICLE_CACHE_MS),
        VEHICLE_STALE_MAX_MS: String(VEHICLE_STALE_MAX_MS),
        VEHICLE_MAX_AGE_MINUTES: String(VEHICLE_MAX_AGE_MINUTES),
        VEHICLE_UPSTREAM_TIMEOUT_MS: String(VEHICLE_UPSTREAM_TIMEOUT_MS),
        LOG_LEVEL: 'INFO',
      },
    });

    // Lukuoikeus vain Nyssen API-avaimeen (sama parametri kuin ingest-nysse
    // lukee — ks. ingestion-stack.ts). Ei laajempia SSM-oikeuksia. Sama
    // parametri tarvitaan myös pysäkkimonitoriin (§28), joten ARN on yhteinen.
    const nysseApiKeyArn =
      `arn:aws:ssm:${this.region}:${this.account}:parameter` +
      `/tampere360/${appContext.envName}/sources/nysse/api-key`;

    this.vehiclesFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [nysseApiKeyArn] }),
    );

    const vehicleIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      'VehiclesIntegration',
      this.vehiclesFunction,
    );

    // --- Pysäkit ja pysäkkimonitori (§28) ---------------------------------------
    // Hakee GTFS-static-pysäkit (ITS Factory, ~17 Mt zip, cache 6 h) ja yhden
    // pysäkin reaaliaikaiset lähdöt Waltti SIRI StopMonitoringista (cache 15 s).
    // Ei DynamoDB-käyttöä: pysäkit ovat staattista dataa ja lähdöt hetkellisiä.
    this.stopsFunction = new lambdaNodejs.NodejsFunction(this, 'StopsFunction', {
      entry: path.join(__dirname, '../../apps/stops/src/handler.ts'),
      handler: 'handler',
      functionName: resourceName(appContext.envName, 'stops'),
      description: 'Tampere360: Nysse-pysäkit ja pysäkkimonitori (GTFS static + Waltti SIRI SM)',
      runtime: lambda.Runtime.NODEJS_22_X,
      // GTFS-paketin purku (17 Mt zip → stops.txt) on selvästi raskaampi
      // operaatio kuin pelkkä HTTP-haku, joten muistia on enemmän kuin
      // ajoneuvo- ja query-Lambdoilla (256 Mt).
      memorySize: 512,
      timeout: cdk.Duration.seconds(25),
      // Kustannuskatto: ks. config.ts STOP_RESERVED_CONCURRENCY.
      reservedConcurrentExecutions: STOP_RESERVED_CONCURRENCY,
      environment: {
        ENVIRONMENT: appContext.envName,
        SSM_API_KEY_PATH: `/tampere360/${appContext.envName}/sources/nysse/api-key`,
        GTFS_STOPS_URL,
        GTFS_STOPS_CACHE_MS: String(GTFS_STOPS_CACHE_MS),
        GTFS_STOPS_STALE_MAX_MS: String(GTFS_STOPS_STALE_MAX_MS),
        GTFS_STOPS_TIMEOUT_MS: String(GTFS_STOPS_TIMEOUT_MS),
        STOP_CACHE_MS: String(STOP_CACHE_MS),
        STOP_STALE_MAX_MS: String(STOP_STALE_MAX_MS),
        STOP_CACHE_MAX_ENTRIES: String(STOP_CACHE_MAX_ENTRIES),
        STOP_PREVIEW_MINUTES: String(STOP_PREVIEW_MINUTES),
        STOP_DEPARTURE_LIMIT: String(STOP_DEPARTURE_LIMIT),
        STOP_UPSTREAM_TIMEOUT_MS: String(STOP_UPSTREAM_TIMEOUT_MS),
        LOG_LEVEL: 'INFO',
      },
    });

    this.stopsFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [nysseApiKeyArn] }),
    );

    const stopsIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      'StopsIntegration',
      this.stopsFunction,
    );

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
    // Kustannussuoja: ks. config.ts API_THROTTLE — ylimenevä liikenne saa 429.
    const defaultStage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: API_THROTTLE.rateLimit, burstLimit: API_THROTTLE.burstLimit },
    });

    for (const route of API_ROUTES) {
      this.httpApi.addRoutes({
        path: route,
        methods: [apigwv2.HttpMethod.GET],
        integration,
      });
    }

    for (const route of VEHICLE_ROUTES) {
      this.httpApi.addRoutes({
        path: route,
        methods: [apigwv2.HttpMethod.GET],
        integration: vehicleIntegration,
      });
    }

    for (const route of STOP_ROUTES) {
      this.httpApi.addRoutes({
        path: route,
        methods: [apigwv2.HttpMethod.GET],
        integration: stopsIntegration,
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
