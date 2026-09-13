/**
 * IngestionStack — keräysputken etupää (arkkitehtuuri §1–2).
 *
 * Jokaisella lähteellä on:
 *  - oma NodejsFunction-adapteri-Lambda (apps/ingest-<id>/src/handler.ts)
 *  - EventBridge Scheduler -ajastus (rate §9-taulukon mukaan) + oma DLQ
 *    ("Source Scheduler DLQ", §12: erilliset DLQ:t, ei yhteistä)
 *  - Parameter Store -konfiguraatio: enabled / base-url / poll-interval (§8)
 *
 * Lisäksi:
 *  - SQS ingestion queue + Raw Ingestion DLQ (redrive, maxReceiveCount 5)
 *  - normalisointi-Lambda (apps/normalize) SQS-triggerillä +
 *    Normalization DLQ (normalisoinnin epäonnistuneet erät, §12)
 */

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import type { AppContext, SourceDefinition } from './config';
import { SOURCE_DEFINITIONS, resourceName } from './config';

export interface IngestionStackProps extends cdk.StackProps {
  appContext: AppContext;
  dataKey: kms.IKey;
  rawBucket: s3.IBucket;
  eventBus: events.IEventBus;
  ingestionStateTable: dynamodb.ITable;
}

/** Rakennuspalikka: lähdekohtainen Lambda + Scheduler + DLQ + SSM-parametrit. */
interface SourceResources {
  fn: lambdaNodejs.NodejsFunction;
  schedulerDlq: sqs.Queue;
  schedule: scheduler.Schedule;
}

function pascal(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export class IngestionStack extends cdk.Stack {
  /** SQS ingestion queue: adapterit → normalisointi (§2). */
  public readonly ingestionQueue: sqs.Queue;
  /** Raw Ingestion DLQ (§12.2). */
  public readonly ingestionDlq: sqs.Queue;
  /** Normalization DLQ (§12.3). */
  public readonly normalizationDlq: sqs.Queue;
  /** Lähdekohtaiset Scheduler DLQ:t (§12.1) valvontaa varten. */
  public readonly schedulerDlqs: { name: string; queue: sqs.Queue }[] = [];
  /** Kaikki adapteri-Lambdat valvontaa varten. */
  public readonly adapterFunctions: { name: string; fn: lambda.IFunction }[] = [];
  /** Normalisointi-Lambda valvontaa varten. */
  public normalizeFunction!: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    const { appContext, dataKey, rawBucket, eventBus, ingestionStateTable } = props;

    // --- SQS ingestion queue + Raw Ingestion DLQ ---------------------------

    this.ingestionDlq = new sqs.Queue(this, 'IngestionDlq', {
      queueName: resourceName(appContext.envName, 'ingestion-dlq'),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      enforceSSL: true,
    });

    this.ingestionQueue = new sqs.Queue(this, 'IngestionQueue', {
      queueName: resourceName(appContext.envName, 'ingestion'),
      // visibilityTimeout >= 6 x normalisoinnin timeout (SQS-best practice)
      visibilityTimeout: cdk.Duration.seconds(360),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      enforceSSL: true,
      deadLetterQueue: { queue: this.ingestionDlq, maxReceiveCount: 5 },
    });

    // --- Normalization DLQ --------------------------------------------------
    // Normalisointi-Lambda saa lähetysoikeuden; varsinainen lähetys
    // sovelluskoodissa (Vaihe 2), kun normalisointi epäonnistuu pysyvästi.
    this.normalizationDlq = new sqs.Queue(this, 'NormalizationDlq', {
      queueName: resourceName(appContext.envName, 'normalization-dlq'),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      enforceSSL: true,
    });

    // --- Lähdekohtaiset adapterit, ajastukset ja konfiguraatiot -------------

    const scheduleGroup = new scheduler.ScheduleGroup(this, 'SourceScheduleGroup', {
      scheduleGroupName: resourceName(appContext.envName, 'sources'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    for (const source of SOURCE_DEFINITIONS) {
      this.buildSource(source, { appContext, rawBucket, ingestionStateTable, scheduleGroup });
    }

    // --- Normalisointi-Lambda ------------------------------------------------

    this.normalizeFunction = new lambdaNodejs.NodejsFunction(this, 'NormalizeFunction', {
      entry: path.join(__dirname, '../../apps/normalize/src/handler.ts'),
      handler: 'handler',
      functionName: resourceName(appContext.envName, 'normalize'),
      description: 'Tampere360 normalisointi: SQS raakaerä -> Tampere360Event -> EventBridge',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ENVIRONMENT: appContext.envName,
        EVENT_BUS_NAME: eventBus.eventBusName,
        NORMALIZATION_DLQ_URL: this.normalizationDlq.queueUrl,
        RAW_BUCKET_NAME: rawBucket.bucketName,
        LOG_LEVEL: 'INFO',
      },
    });

    this.ingestionQueue.grantConsumeMessages(this.normalizeFunction);
    dataKey.grantDecrypt(this.normalizeFunction);
    eventBus.grantPutEventsTo(this.normalizeFunction);
    this.normalizationDlq.grantSendMessages(this.normalizeFunction);
    rawBucket.grantRead(this.normalizeFunction);

    this.normalizeFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(this.ingestionQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    new cdk.CfnOutput(this, 'IngestionQueueUrl', { value: this.ingestionQueue.queueUrl });
  }

  private buildSource(
    source: SourceDefinition,
    deps: {
      appContext: AppContext;
      rawBucket: s3.IBucket;
      ingestionStateTable: dynamodb.ITable;
      scheduleGroup: scheduler.ScheduleGroup;
    },
  ): SourceResources {
    const { appContext, rawBucket, ingestionStateTable, scheduleGroup } = deps;
    const name = pascal(source.id);
    const env = appContext.envName;
    const appDir = source.appDir ?? `ingest-${source.id}`;

    // Adapteri-Lambda (NodejsFunction/esbuild, arkkitehtuuri §16 Vaihe 1).
    const fn = new lambdaNodejs.NodejsFunction(this, `${name}AdapterFunction`, {
      entry: path.join(__dirname, `../../apps/${appDir}/src/handler.ts`),
      handler: 'handler',
      functionName: resourceName(env, `ingest-${source.id}`),
      description: source.description,
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ENVIRONMENT: env,
        SOURCE_SYSTEM: source.system,
        RAW_BUCKET_NAME: rawBucket.bucketName,
        INGESTION_QUEUE_URL: this.ingestionQueue.queueUrl,
        INGESTION_STATE_TABLE_NAME: ingestionStateTable.tableName,
        LOG_LEVEL: 'INFO',
      },
    });
    // Lähdekohtaiset ympäristömuuttujat
    if (source.id === 'nysse') {
      fn.addEnvironment('NYSSE_BASE_URL', 'https://data.waltti.fi/tampere/api/gtfsrealtime/v1.0/feed/servicealerts');
      // Aseta NYSSE_API_KEY joko SSM-parametrillä tai ympäristömuuttujalla
      // /tampere360/{env}/sources/nysse/api-key (String tai SecureString)
// API-avain SSM SecureString -parametriin (käyttäjä asettaa käsin)
    if (source.id === 'nysse') {
      const apiKeyParam = new ssm.StringParameter(this, `${pascal(source.id)}ApiKeyParam`, {
        parameterName: `/tampere360/${env}/sources/${source.id}/api-key`,
        stringValue: 'CHANGE_ME',
        description: `Nysse Waltti-API-avain. Aseta todellinen arvo AWS Console/CLI:llä.`,
        tier: ssm.ParameterTier.STANDARD,  // SecureString ei salli STANDARD-tasolla → String
      });
      apiKeyParam.grantRead(fn);
      // Huom: Käytä SecureString-parametria ja WithDecryption=true koodissa.
      // Parametri luodaan String-tyyppisenä aluksi; vaihda SecureStringiksi
      // myöhemmässa vaiheessa.
    }
    }

    // Oikeudet: raakadata S3:een, viestit jonoon, checkpoint-taulu, SSM-konffit.
    rawBucket.grantPut(fn, `source=${source.id}/*`);
    this.ingestionQueue.grantSendMessages(fn);
    ingestionStateTable.grantReadWriteData(fn);

    // Lähdekohtainen Parameter Store -konfiguraatio (§8).
    const paramPrefix = `/tampere360/${env}/sources/${source.id}`;
    const baseUrlBySource: Record<string, string> = {
      'fmi-cap': 'https://alerts.fmi.fi/cap/feed/rss_fi-FI.rss',
      'tampere-traffic': 'https://traffic-incidents.tampere.fi/api/v1',
      'police': 'https://poliisi.fi/sisa-suomen-poliisilaitos/-/asset_publisher/ZtAEeHB39Lxr/rss',
    };
    const enabledParam = new ssm.StringParameter(this, `${name}EnabledParam`, {
      parameterName: `${paramPrefix}/enabled`,
      stringValue: String(source.enabled),
      description: `Onko lähde ${source.system} käytössä`,
    });
    const baseUrlParam = new ssm.StringParameter(this, `${name}BaseUrlParam`, {
      parameterName: `${paramPrefix}/base-url`,
      // 'TBD' = URL ei vielä selvitetty (arkkitehtuuri §18). SSM ei hyväksy tyhjää arvoa.
      stringValue: baseUrlBySource[source.id] ?? 'TBD',
      description: `Lähteen ${source.system} rajapinnan URL (TBD = selvitettävä, ks. §18)`,
    });
    const pollParam = new ssm.StringParameter(this, `${name}PollIntervalParam`, {
      parameterName: `${paramPrefix}/poll-interval`,
      stringValue: String(source.scheduleRateMinutes),
      description: `Hakuväli minuutteina lähteelle ${source.system}`,
    });
    for (const param of [enabledParam, baseUrlParam, pollParam]) {
      param.grantRead(fn);
    }

    // Source Scheduler DLQ (§12.1) — oma DLQ per lähde.
    // SQS-managed salaus: EventBridge Schedulerin palvelurooli voi kirjoittaa
    // jonoon ilman erillistä KMS-avainpolitiikkaa.
    const schedulerDlq = new sqs.Queue(this, `${name}SchedulerDlq`, {
      queueName: resourceName(env, `ingest-${source.id}-scheduler-dlq`),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.schedulerDlqs.push({ name: `ingest-${source.id}`, queue: schedulerDlq });

    // Ajastus: rate §9-taulukosta, DLQ + rajattu retry (§11).
    const schedule = new scheduler.Schedule(this, `${name}Schedule`, {
      scheduleName: resourceName(env, `fetch-${source.id}`),
      scheduleGroup,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(source.scheduleRateMinutes)),
      enabled: source.enabled,
      description: `Hae lähde ${source.system} ${source.scheduleRateMinutes} min välein`,
      target: new schedulerTargets.LambdaInvoke(fn, {
        deadLetterQueue: schedulerDlq,
        retryAttempts: 3,
        input: scheduler.ScheduleTargetInput.fromObject({
          source: source.system,
          environment: env,
        }),
      }),
    });

    this.adapterFunctions.push({ name: `ingest-${source.id}`, fn });

    return { fn, schedulerDlq, schedule };
  }
}
