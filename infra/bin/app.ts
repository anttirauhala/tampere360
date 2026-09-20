#!/usr/bin/env node
/**
 * Tampere360 CDK-sovellus (arkkitehtuuri §14).
 *
 * Stack-järjestys: Foundation → Data → Eventing → Ingestion →
 * EventProcessing → Api → Frontend → Monitoring. Lisäksi opt-in WafStack
 * (us-east-1) kun oma domain ja WAF ovat käytössä.
 *
 * Environment valitaan kontekstilla `-c env=dev|test|prod`. Domain ja TLS
 * tulevat ympäristökohtaisesta konfiguraatiosta (lib/config.ts,
 * ENVIRONMENT_DOMAINS) — prod käyttää omaa domainia, dev/test CloudFrontin
 * oletusdomainia.
 *
 * Käyttö:
 *   cd infra
 *   npx cdk synth                                    # syntesoi (dev-oletus)
 *   npx cdk deploy --all                             # dev
 *   npx cdk deploy --all -c env=prod --region eu-north-1 -c wafEnabled=true
 *   npx cdk diff  --all -c env=prod --region eu-north-1
 *
 * Ks. prod-runbook: docs/architecture/prod-deploy.md
 */

import * as cdk from 'aws-cdk-lib';

import type { AppContext, EnvName } from '../lib/config';
import { ENVIRONMENT_DOMAINS } from '../lib/config';
import { ApiStack } from '../lib/api-stack';
import { DataStack } from '../lib/data-stack';
import { EventingStack } from '../lib/eventing-stack';
import { EventProcessingStack } from '../lib/event-processing-stack';
import { FoundationStack } from '../lib/foundation-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { IngestionStack } from '../lib/ingestion-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { WafStack } from '../lib/waf-stack';

const app = new cdk.App();

/**
 * Lukee CDK-kontekstin totuusarvon. **Tärkeää:** komentoriviltä annettu
 * `-c wafEnabled=true` tulee kontekstiin merkkijonona `"true"`, joten
 * pelkkä `=== true` -vertailu ei riitä (vanha bugi: WAF ei koskaan kytkeytynyt).
 */
function contextFlag(key: string, defaultValue: boolean): boolean {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return raw === true || raw === 'true';
}

const envName = (app.node.tryGetContext('env') ?? 'dev') as EnvName;
if (!['dev', 'test', 'prod'].includes(envName)) {
  throw new Error(`Virheellinen env-konteksti: ${envName} (sallitut: dev, test, prod)`);
}

const region = process.env['CDK_DEFAULT_REGION'] ?? 'eu-west-1';
const account =
  (app.node.tryGetContext('account') as string | undefined) ?? process.env['CDK_DEFAULT_ACCOUNT'];

if (envName === 'prod' && !account) {
  throw new Error(
    'prod-deploy vaatii AWS-tilin: aseta AWS_PROFILE tai CDK_DEFAULT_ACCOUNT ' +
      '(tai aja `cdk deploy --profile <profili>`).',
  );
}

const env: cdk.Environment = {
  account,
  region,
};

const wafEnabled = contextFlag('wafEnabled', false);
// Domain tulee ympäristökohtaisesta konfiguraatiosta (config.ts). Dev/test
// käyttävät CloudFrontin oletusdomainia; prod käyttää omaa domainia.
// `-c domainEnabled=false` pakottaa oletusdomainin myös prodissa.
const domain = contextFlag('domainEnabled', true) ? ENVIRONMENT_DOMAINS[envName] : undefined;

const appContext: AppContext = {
  envName,
  account,
  region,
  wafEnabled,
  domain,
};

cdk.Tags.of(app).add('project', 'tampere360');
cdk.Tags.of(app).add('environment', envName);

const prefix = `tampere360-${envName}`;

// WAF (CloudFront-scope) on luotava us-east-1:een → oma stack, opt-in.
// WafStack on luotava ennen FrontendStackia, koska jakelu viittaa sen ARN:iin
// cross-region-viittauksena.
const waf = wafEnabled
  ? new WafStack(app, `${prefix}-waf`, { appContext, env: { account, region: 'us-east-1' } })
  : undefined;

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
  domain,
});

// FrontendStack: web-bucket + CloudFront + Vite-buildi (apps/web) ja
// ajonaikainen /config.json, jossa API-osoite. Prodissa lisäksi oma domain
// (ACM us-east-1) + Route 53 -alias-tietueet + WAF.
new FrontendStack(app, `${prefix}-frontend`, {
  appContext,
  env,
  apiUrl: api.httpApiUrl,
  domain,
  webAclArn: waf?.webAclArn,
  // WAF-ARN on cross-region-viittaus (us-east-1 -> eu-north-1).
  crossRegionReferences: wafEnabled,
});

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
    { name: 'situation-expiry', fn: processing.expiryFunction },
    { name: 'api', fn: api.queryFunction },
  ],
  httpApi: api.httpApi,
});

app.synth();
