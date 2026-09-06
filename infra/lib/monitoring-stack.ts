/**
 * MonitoringStack — valvonta (arkkitehtuuri §12–13).
 *
 * CloudWatch-dashboard: putken mittarit (SQS-jonojen pituus, vanhimman
 * viestin ikä, Lambda errors, DLQ-viestit) sekä hälytykset:
 *  - DLQ:ssa >= 1 viesti (kaikki DLQ:t)
 *  - normalisointijonon vanhin viesti > 5 min
 *  - Lambda-virheet >= 5 / 5 min
 *
 * Lähdekohtaiset business-mittarit (datan ikä, haetut tietueet) lisätään
 * Vaiheessa 2+ adapterien lähettäminä custom-mittareina.
 */

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import { resourceName } from './config';

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
      displayName: 'Tampere247 hälytykset',
    });
    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

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
