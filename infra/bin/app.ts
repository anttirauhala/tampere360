#!/usr/bin/env node
/**
 * Tampere360 CDK-sovellus (arkkitehtuuri §14).
 *
 * Stack-järjestys: Foundation → Data → Eventing → Ingestion →
 * EventProcessing → Api → Frontend → Monitoring.
 *
 * Käyttö:
 *   cdk synth                        # syntesoi kaikki stackit
 *   cdk deploy --all                 # deploy (dev-oletus)
 *   cdk deploy --all -c env=test     # toinen ympäristö
 *   cdk deploy --all -c wafEnabled=true
 */

import * as cdk from 'aws-cdk-lib';

import type { AppContext, EnvName } from '../lib/config';
import { ApiStack } from '../lib/api-stack';
import { DataStack } from '../lib/data-stack';
import { EventingStack } from '../lib/eventing-stack';
import { EventProcessingStack } from '../lib/event-processing-stack';
import { FoundationStack } from '../lib/foundation-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { IngestionStack } from '../lib/ingestion-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();

const envName = (app.node.tryGetContext('env') ?? 'dev') as EnvName;
if (!['dev', 'test', 'prod'].includes(envName)) {
  throw new Error(`Virheellinen env-konteksti: ${envName} (sallitut: dev, test, prod)`);
}

const region = process.env['CDK_DEFAULT_REGION'] ?? 'eu-west-1';

const env: cdk.Environment = {
  account: process.env['CDK_DEFAULT_ACCOUNT'],
  region,
};

const appContext: AppContext = {
  envName,
  account: env.account,
  region,
  wafEnabled: app.node.tryGetContext('wafEnabled') === true,
};

cdk.Tags.of(app).add('project', 'tampere360');
cdk.Tags.of(app).add('environment', envName);

const prefix = `tampere360-${envName}`;

const foundation = new FoundationStack(app, `${prefix}-foundation`, { appContext, env });

const data = new DataStack(app, `${prefix}-data`, {
  appContext,
  env,
  dataKey: foundation.dataKey,
});

const eventing = new EventingStack(app, `${prefix}-eventing`, { appContext, env });

const ingestion = new IngestionStack(app, `${prefix}-ingestion`, {
  appContext,
  env,
  dataKey: foundation.dataKey,
  rawBucket: data.rawBucket,
  eventBus: eventing.eventBus,
  ingestionStateTable: data.ingestionStateTable,
});

const processing = new EventProcessingStack(app, `${prefix}-event-processing`, {
  appContext,
  env,
  eventBus: eventing.eventBus,
  situationsTable: data.situationsTable,
  sourceEventsTable: data.sourceEventsTable,
});

const api = new ApiStack(app, `${prefix}-api`, {
  appContext,
  env,
  situationsTable: data.situationsTable,
  sourceEventsTable: data.sourceEventsTable,
  ingestionStateTable: data.ingestionStateTable,
});

// FrontendStack: web-bucket + CloudFront (React SPA deployataan Vaiheessa 4).
new FrontendStack(app, `${prefix}-frontend`, { appContext, env });

new MonitoringStack(app, `${prefix}-monitoring`, {
  appContext,
  env,
  dlqs: [
    ...ingestion.schedulerDlqs,
    { name: 'ingestion', queue: ingestion.ingestionDlq },
    { name: 'normalization', queue: ingestion.normalizationDlq },
    { name: 'domain-event-delivery', queue: processing.domainEventDeliveryDlq },
  ],
  ingestionQueue: ingestion.ingestionQueue,
  lambdas: [
    ...ingestion.adapterFunctions,
    { name: 'normalize', fn: ingestion.normalizeFunction },
    { name: 'situation-processor', fn: processing.situationProcessorFunction },
    { name: 'api', fn: api.queryFunction },
  ],
  httpApi: api.httpApi,
});

app.synth();
