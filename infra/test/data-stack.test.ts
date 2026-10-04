import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { describe, expect, it } from 'vitest';

import type { AppContext } from '../lib/config';
import { DataStack } from '../lib/data-stack';

/**
 * Raakabucketin salauksen regressiosuoja (kustannusoptimointi 4.10.2026).
 *
 * Raakabucket käyttää SSE-KMS:ää asiakashallitulla avaimella. **Ilman S3
 * Bucket Keytä jokainen objektioperaatio tekee KMS-kutsun** — ja koska
 * raakadataan kirjoitettiin aiemmin objekti per tietue per minuutti, KMS:n
 * pyyntökustannus nousi yhdeksi suurimmista eristä (~0,31 $/vrk eli ~9 $/kk).
 * AWS: bucket key vähentää KMS-pyyntöjä jopa 99 %.
 */

const APP_CONTEXT: AppContext = {
  envName: 'dev',
  account: '132339120388',
  region: 'eu-north-1',
  wafEnabled: false,
};

interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

interface EncryptionRule {
  BucketKeyEnabled?: boolean;
  ServerSideEncryptionByDefault?: { SSEAlgorithm?: string; KMSMasterKeyID?: unknown };
}

/** Synteesoidaan kerran (CDK-synth on raskas). */
let synthesized: Record<string, TemplateResource> | null = null;

function resources(): Record<string, TemplateResource> {
  if (!synthesized) {
    const app = new cdk.App();
    const env = { account: APP_CONTEXT.account, region: APP_CONTEXT.region };
    // Avain luodaan omaan stackiinsa (kuten FoundationStack tuotannossa) ja
    // viitataan siihen DataStackista — näin DataStack saadaan synteesoitua
    // ilman koko sovellusta.
    const keyStack = new cdk.Stack(app, 'KeyStack', { env });
    const dataKey = new kms.Key(keyStack, 'DataKey');
    const stack = new DataStack(app, 'TestData', { env, appContext: APP_CONTEXT, dataKey });
    synthesized = (
      Template.fromStack(stack).toJSON() as { Resources: Record<string, TemplateResource> }
    ).Resources;
  }
  return synthesized;
}

function rawBucket(): TemplateResource | undefined {
  return Object.values(resources()).find((r) => r.Type === 'AWS::S3::Bucket');
}

function bucketEncryption(): EncryptionRule | undefined {
  const encryption = rawBucket()?.Properties?.['BucketEncryption'] as
    { ServerSideEncryptionConfiguration?: EncryptionRule[] } | undefined;
  return encryption?.ServerSideEncryptionConfiguration?.[0];
}

describe('DataStack — raakabucketin salaus', () => {
  it('käyttää S3 Bucket Keytä (KMS-pyyntö per objektioperaatio pois)', () => {
    expect(rawBucket()).toBeDefined();
    expect(bucketEncryption()?.BucketKeyEnabled).toBe(true);
  }, 30_000);

  it('salaa raakabucketin edelleen SSE-KMS:llä', () => {
    expect(bucketEncryption()?.ServerSideEncryptionByDefault?.SSEAlgorithm).toBe('aws:kms');
  }, 30_000);

  it('luo kolme DynamoDB-taulua (Situations, SourceEvents, IngestionState)', () => {
    const tables = Object.values(resources()).filter((r) => r.Type === 'AWS::DynamoDB::Table');
    expect(tables).toHaveLength(3);
  }, 30_000);
});
