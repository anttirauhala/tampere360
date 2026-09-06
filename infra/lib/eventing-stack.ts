/**
 * EventingStack — EventBridge custom event bus + arkisto (arkkitehtuuri §2–3, §12).
 *
 * Normalisoidut domain-tapahtumat kulkevat tämän busin kautta. Uudet
 * prosessorit (ilmoitukset, tilastot) liitetään myöhemmin uusina
 * EventBridge-sääntöinä ilman muutoksia putkeen.
 *
 * Domain Event Delivery DLQ luodaan EventProcessingStackissa, koska se
 * kytketään situation-processor-säännön kohteen deadLetterQueueksi.
 */

import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';

import { EVENT_SOURCE } from '@tampere247/event-contracts';

import type { AppContext } from './config';
import { resourceName } from './config';

export interface EventingStackProps extends cdk.StackProps {
  appContext: AppContext;
}

export class EventingStack extends cdk.Stack {
  /** Custom event bus: tampere247-domain-tapahtumien reititin. */
  public readonly eventBus: events.EventBus;

  constructor(scope: Construct, id: string, props: EventingStackProps) {
    super(scope, id, props);

    const { appContext } = props;

    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: resourceName(appContext.envName, 'events'),
      description: 'Tampere247 domain-tapahtumat (normalisoidut tilanteet)',
    });

    // Arkistointi mahdollistaa tapahtumien uudelleenajon ja virhetutkinnan
    // (arkkitehtuuri §12: EventBridge Archive: suodatus, säilytysaika, uudelleenajo).
    new events.Archive(this, 'EventArchive', {
      sourceEventBus: this.eventBus,
      eventPattern: { source: [EVENT_SOURCE] },
      retention: cdk.Duration.days(30),
      description: 'Tampere247 domain-tapahtumien arkisto (30 pv)',
    });

    new cdk.CfnOutput(this, 'EventBusName', { value: this.eventBus.eventBusName });
    new cdk.CfnOutput(this, 'EventBusArn', { value: this.eventBus.eventBusArn });
  }
}
