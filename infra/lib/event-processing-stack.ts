/**
 * EventProcessingStack — domain-tapahtumien prosessointi (arkkitehtuuri §2–4).
 *
 * situation-processor-Lambda on custom busin catch-all-säännön kohde
 * (MVP-rajaus §3): se tekee validoinnin, aluesuodatuksen, teknisen
 * idempotenssin (attribute_not_exists(processingKey)), semanttisen
 * yhdistämisen ja DynamoDB-kirjoitukset.
 *
 * Uudet prosessorit (ilmoitukset, tilastot) liitetään myöhemmin uusina
 * EventBridge-sääntöinä ilman muutoksia putkeen.
 *
 * Domain Event Delivery DLQ (§12.4): EventBridge-toimituksen epäonnistuessa
 * (Lambda-virhe retryjen jälkeen) tapahtuma ohjataan tähän jonoon.
 */

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { EVENT_SOURCE } from '@tampere247/event-contracts';

import type { AppContext } from './config';
import { resourceName } from './config';

export interface EventProcessingStackProps extends cdk.StackProps {
  appContext: AppContext;
  eventBus: events.IEventBus;
  situationsTable: dynamodb.ITable;
  sourceEventsTable: dynamodb.ITable;
}

export class EventProcessingStack extends cdk.Stack {
  /** Situation-processor-Lambda valvontaa varten. */
  public readonly situationProcessorFunction: lambdaNodejs.NodejsFunction;
  /** Domain Event Delivery DLQ (§12.4) valvontaa varten. */
  public readonly domainEventDeliveryDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: EventProcessingStackProps) {
    super(scope, id, props);

    const { appContext, eventBus, situationsTable, sourceEventsTable } = props;

    // SQS-managed salaus: EventBridge-säännön palvelurooli voi kirjoittaa
    // DLQ:hun ilman erillistä KMS-avainpolitiikkaa.
    this.domainEventDeliveryDlq = new sqs.Queue(this, 'DomainEventDeliveryDlq', {
      queueName: resourceName(appContext.envName, 'domain-event-delivery-dlq'),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.situationProcessorFunction = new lambdaNodejs.NodejsFunction(
      this,
      'SituationProcessorFunction',
      {
        entry: path.join(__dirname, '../../apps/situation-processor/src/handler.ts'),
        handler: 'handler',
        functionName: resourceName(appContext.envName, 'situation-processor'),
        description:
          'Tampere247 situation-processor: validointi, aluesuodatus, dedup, DynamoDB-kirjoitukset',
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(60),
        environment: {
          ENVIRONMENT: appContext.envName,
          EVENT_BUS_NAME: eventBus.eventBusName,
          SITUATIONS_TABLE_NAME: situationsTable.tableName,
          SOURCE_EVENTS_TABLE_NAME: sourceEventsTable.tableName,
          LOG_LEVEL: 'INFO',
        },
      },
    );

    situationsTable.grantReadWriteData(this.situationProcessorFunction);
    sourceEventsTable.grantReadWriteData(this.situationProcessorFunction);
    eventBus.grantPutEventsTo(this.situationProcessorFunction);

    // Catch-all-sääntö: kaikki tampere247-domain-tapahtumat prosessorille.
    // MaxEventAge 1 h: vanhoja tapahtumia ei kirjoiteta tilannekuvaan (§11).
    const rule = new events.Rule(this, 'DomainEventsCatchAllRule', {
      eventBus,
      eventPattern: { source: [EVENT_SOURCE] },
      description: 'Tampere247 domain-tapahtumat -> situation-processor',
    });
    rule.addTarget(
      new eventsTargets.LambdaFunction(this.situationProcessorFunction, {
        deadLetterQueue: this.domainEventDeliveryDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(1),
      }),
    );

    new cdk.CfnOutput(this, 'SituationProcessorFunctionName', {
      value: this.situationProcessorFunction.functionName,
    });
  }
}
