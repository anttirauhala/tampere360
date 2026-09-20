/**
 * MonitoringStack — valvonta (arkkitehtuuri §12–13).
 *
 * CloudWatch-dashboard: putken mittarit (SQS-jonojen pituus, vanhimman
 * viestin ikä, Lambda errors, DLQ-viestit) sekä hälytykset:
 *  - DLQ:ssa >= 1 viesti (kaikki DLQ:t)
 *  - normalisointijonon vanhin viesti > 5 min
 *  - Lambda-virheet >= 5 / 5 min
 *  - Kustannussuojat: API-pyyntöpiikki, API 4xx (429-throttlaukset) ja
 *    query-Lambdan throttlaukset (ks. config.ts API_*_PER_5MIN)
 *
 * Kaikki hälytykset menevät SNS-topiciin `tampere360-{env}-alarms`. **Tilaa
 * topiciin oma sähköposti**, muuten hälytykset eivät tavoita ketään
 * (ks. docs/architecture/prod-deploy.md §4). Sama topici on tarkoitettu myös
 * AWS Budgets -ilmoituksille (topic policy sallii budgets.amazonaws.com).
 */

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import {
  API_CLIENT_ERRORS_PER_5MIN,
  API_REQUEST_SPIKE_PER_5MIN,
  QUERY_RESERVED_CONCURRENCY,
  resourceName,
} from './config';

export interface MonitoringStackProps extends cdk.StackProps {
  appContext: AppContext;
  /** Kaikki DLQ:t nimettynä (hälytys: >= 1 viesti). */
  dlqs: { name: string; queue: sqs.IQueue }[];
  /** Ingestion-jono (vanhimman viestin iän hälytys). */
  ingestionQueue: sqs.IQueue;
  /** Putken Lambdat nimettynä (virhehälytykset + dashboard). */
  lambdas: { name: string; fn: lambda.IFunction }[];
  /** HTTP API (dashboard). */
  httpApi: apigwv2.HttpApi;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { appContext, dlqs, ingestionQueue, lambdas, httpApi } = props;

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: resourceName(appContext.envName, 'alarms'),
      displayName: 'Tampere360 hälytykset',
    });
    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    // AWS Budgets -ilmoitukset samaan topiciin (ks. docs/architecture/prod-deploy.md
    // §8: budjetin notifikaatiot lisätään AWS CLI:llä, koska budjetti on
    // olemassa jo valmiiksi eikä sitä luoda CDK:lla).
    alarmTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBudgetsToPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [alarmTopic.topicArn],
        ...(appContext.account
          ? { conditions: { StringEquals: { 'aws:SourceAccount': appContext.account } } }
          : {}),
      }),
    );

    // --- Hälytykset -----------------------------------------------------------

    // DLQ:ssa >= 1 viesti (§13) — jokaiselle DLQ:lle oma hälytys.
    for (const { name, queue } of dlqs) {
      const alarm = new cloudwatch.Alarm(this, `DlqAlarm-${name}`, {
        alarmName: resourceName(appContext.envName, `dlq-${name}`),
        alarmDescription: `DLQ ${name}: vähintään yksi viesti odottaa käsittelyä`,
        metric: queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
    }

    // Normalisointijonon vanhin viesti > 5 min (§13).
    const oldestMessageAlarm = new cloudwatch.Alarm(this, 'IngestionAgeAlarm', {
      alarmName: resourceName(appContext.envName, 'ingestion-age'),
      alarmDescription: 'Normalisointijonon vanhin viesti yli 5 minuuttia',
      metric: ingestionQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 300,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    oldestMessageAlarm.addAlarmAction(alarmAction);

    // Lambda-virheet >= 5 / 5 min (§13: "Tampere Traffic API epäonnistui 5 kertaa").
    for (const { name, fn } of lambdas) {
      const alarm = new cloudwatch.Alarm(this, `LambdaErrorsAlarm-${name}`, {
        alarmName: resourceName(appContext.envName, `errors-${name}`),
        alarmDescription: `Lambda ${name}: vähintään 5 virhettä 5 minuutissa`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
    }

    // --- Kustannussuojat ---------------------------------------------------
    // Julkinen API ilman avainta: nämä hälytykset kertovat väärinkäytöstä
    // (tai väärin mitoitetusta throttlesta) ennen kuin lasku kasvaa.

    // API-pyyntöpiikki: normaali liikenne on satoja pyyntöjä / 5 min.
    const apiSpikeAlarm = new cloudwatch.Alarm(this, 'ApiRequestSpikeAlarm', {
      alarmName: resourceName(appContext.envName, 'api-request-spike'),
      alarmDescription: `API-pyyntöjä >= ${API_REQUEST_SPIKE_PER_5MIN} / 5 min (≈3,3 req/s) — mahdollinen väärinkäyttö tai skannaus`,
      metric: httpApi.metricCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: API_REQUEST_SPIKE_PER_5MIN,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiSpikeAlarm.addAlarmAction(alarmAction);

    // API 4xx: sisältää 429-vastaukset eli sen, että throttlausraja on tullut
    // vastaan (§14: "10 req/s + burst 20").
    const apiClientErrorAlarm = new cloudwatch.Alarm(this, 'ApiClientErrorsAlarm', {
      alarmName: resourceName(appContext.envName, 'api-client-errors'),
      alarmDescription: `API 4xx (sis. 429-throttlaukset) >= ${API_CLIENT_ERRORS_PER_5MIN} / 5 min`,
      metric: httpApi.metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: API_CLIENT_ERRORS_PER_5MIN,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiClientErrorAlarm.addAlarmAction(alarmAction);

    // Query-Lambdan throttlaukset: varattu concurrency (QUERY_RESERVED_CONCURRENCY)
    // tai kutsuraja tuli vastaan → kustannusten kasvu on katkaistu.
    const apiLambda = lambdas.find((entry) => entry.name === 'api');
    if (apiLambda) {
      const lambdaThrottleAlarm = new cloudwatch.Alarm(this, 'ApiThrottleAlarm', {
        alarmName: resourceName(appContext.envName, 'api-throttles'),
        alarmDescription: `Query-Lambda throttlattu (varattu concurrency ${QUERY_RESERVED_CONCURRENCY} täynnä)`,
        metric: apiLambda.fn.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      lambdaThrottleAlarm.addAlarmAction(alarmAction);
    }

    // --- Dashboard --------------------------------------------------------------

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: resourceName(appContext.envName, 'pipeline'),
    });

    const dlqWidgets = dlqs.map(({ name, queue }) =>
      queue.metricApproximateNumberOfMessagesVisible({ label: name }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DLQ-viestit',
        left: dlqWidgets,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Ingestion-jono (pituus + vanhin viesti)',
        left: [
          ingestionQueue.metricApproximateNumberOfMessagesVisible({ label: 'viestejä' }),
        ],
        right: [
          ingestionQueue.metricApproximateAgeOfOldestMessage({ label: 'vanhin (s)' }),
        ],
        width: 12,
      }),
    );

    const lambdaInvocationWidgets = lambdas.map(({ name, fn }) =>
      fn.metricInvocations({ label: name }),
    );
    const lambdaErrorWidgets = lambdas.map(({ name, fn }) => fn.metricErrors({ label: name }));
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda-invokaatiot',
        left: lambdaInvocationWidgets,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda-virheet',
        left: lambdaErrorWidgets,
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API-pyynnöt',
        left: [httpApi.metricCount({ label: 'pyynnöt' })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API-virheet',
        left: [
          httpApi.metricClientError({ label: '4xx' }),
          httpApi.metricServerError({ label: '5xx' }),
        ],
        width: 12,
      }),
    );

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
