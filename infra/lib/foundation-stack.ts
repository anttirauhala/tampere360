/**
 * FoundationStack — yhteiset perusresurssit: KMS-avain omalle tapahtuma- ja
 * käyttäjädatalle (arkkitehtuuri §14). Muut stackit importtaavat tästä.
 */

import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import { resourceName } from './config';

export interface FoundationStackProps extends cdk.StackProps {
  appContext: AppContext;
}

export class FoundationStack extends cdk.Stack {
  /** KMS-avain: DynamoDB-taulut, S3-bucketit, SQS-jonot. */
  public readonly dataKey: kms.Key;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const { appContext } = props;

    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: resourceName(appContext.envName, 'data-key'),
      description: 'Tampere247 — tapahtuma- ja käyttäjädatan salausavain',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
