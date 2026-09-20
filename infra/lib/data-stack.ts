/**
 * DataStack — pysyvä tallennus (arkkitehtuuri §7).
 *
 * - S3 raw-bucket: jokainen lähteestä haettu raakavastaus (lifecycle: aktiivinen
 *   60 pv → Glacier, poisto 365 pv:n jälkeen)
 * - DynamoDB: Situations, SourceEvents, IngestionState — kolme erillistä
 *   taulua (ei single-table MVP:ssä), koska käyttötarkoitukset, säilytysajat
 *   ja indeksit eroavat toisistaan.
 */

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import { resourceName } from './config';

export interface DataStackProps extends cdk.StackProps {
  appContext: AppContext;
  dataKey: kms.IKey;
}

export class DataStack extends cdk.Stack {
  /** Raakadatan S3-bucket: s3://.../source=<lähde>/year=/month=/day=/hour=/<batchId> */
  public readonly rawBucket: s3.Bucket;
  /** Kanoniset, UI:ssa näkyvät tilanteet. */
  public readonly situationsTable: dynamodb.Table;
  /** Alkuperäisestä lähteestä normalisoidut tapahtumat (idempotenssi §4.1). */
  public readonly sourceEventsTable: dynamodb.Table;
  /** Lähdekohtainen tekninen tila (viimeisin haku, etag, cursor, status). */
  public readonly ingestionStateTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { appContext, dataKey } = props;

    this.rawBucket = new s3.Bucket(this, 'RawBucket', {
      bucketName: resourceName(appContext.envName, 'raw').concat(
        appContext.account ? `-${appContext.account}` : '',
      ),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: appContext.envName !== 'prod',
      lifecycleRules: [
        {
          id: 'raw-data-lifecycle',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(60),
            },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
    });

    // Situations — kanoniset tilanteet. GSI1–GSI4 arkkitehtuuri §7.
    //
    // HUOM lajitteluavaimesta `startsAt`: DynamoDB vaatii GSI:n lajitteluavaimen
    // aina asetetuksi, mutta tapahtuman alkuaika voi olla tuntematon (ks.
    // event.validity.startsAt = null, kun lähde ei kerro sitä). Tästä syystä
    // rivin `startsAt` on **järjestysaika** (alkuaika → julkaisuaika →
    // havaintoaika), ei tapahtuman alkuaika. Tapahtuman oikea alkuaika luetaan
    // API:ssa kentästä event.validity.startsAt ja näytetään UI:ssa muodossa
    // "alkuaika ei tiedossa", kun se on null.
    //
    // Jos lajitteluavain halutaan joskus nimetä uudelleen (esim. `timeKey`),
    // se on tehtävä vaiheittain: DynamoDB sallii vain yhden GSI-luonnin tai
    // -poiston per UpdateTable-kutsu.
    this.situationsTable = new dynamodb.Table(this, 'SituationsTable', {
      tableName: resourceName(appContext.envName, 'situations'),
      partitionKey: { name: 'situationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: appContext.envName === 'prod' },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.situationsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-status-startsAt',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startsAt', type: dynamodb.AttributeType.STRING },
    });
    this.situationsTable.addGlobalSecondaryIndex({
      indexName: 'gsi2-category-startsAt',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startsAt', type: dynamodb.AttributeType.STRING },
    });
    this.situationsTable.addGlobalSecondaryIndex({
      indexName: 'gsi3-municipality-startsAt',
      partitionKey: { name: 'municipality', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startsAt', type: dynamodb.AttributeType.STRING },
    });
    this.situationsTable.addGlobalSecondaryIndex({
      indexName: 'gsi4-geohash-startsAt',
      partitionKey: { name: 'geohash', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startsAt', type: dynamodb.AttributeType.STRING },
    });

    // SourceEvents — idempotenssiavain processingKey (§4.1: attribute_not_exists-kirjoitus).
    this.sourceEventsTable = new dynamodb.Table(this, 'SourceEventsTable', {
      tableName: resourceName(appContext.envName, 'source-events'),
      partitionKey: { name: 'processingKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Situationille kuuluvien lähdetapahtumien hakua varten (§6.2 semanttinen yhdistäminen).
    this.sourceEventsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-situationId-publishedAt',
      partitionKey: { name: 'situationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'publishedAt', type: dynamodb.AttributeType.STRING },
    });

    // IngestionState — lähdekohtainen tekninen tila (§7).
    this.ingestionStateTable = new dynamodb.Table(this, 'IngestionStateTable', {
      tableName: resourceName(appContext.envName, 'ingestion-state'),
      partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName });
    new cdk.CfnOutput(this, 'SituationsTableName', { value: this.situationsTable.tableName });
    new cdk.CfnOutput(this, 'SourceEventsTableName', { value: this.sourceEventsTable.tableName });
    new cdk.CfnOutput(this, 'IngestionStateTableName', { value: this.ingestionStateTable.tableName });
  }
}
