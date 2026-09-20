/**
 * WafStack — AWS WAF CloudFront-jakelulle (arkkitehtuuri §14).
 *
 * **Miksi oma stack ja miksi us-east-1:** CloudFront-scope WAF WebACL on
 * luotava us-east-1:een (globaali palvelu), kun muu infrastruktuuri on
 * eu-north-1:ssä. Tämän vuoksi WAF on erillinen, opt-in-stack
 * (`-c wafEnabled=true`), joka deployataan vain kun oma domain on käytössä.
 *
 * WebACL:n ARN välittyy FrontendStackille cross-region-viittauksena
 * (`crossRegionReferences`), joten deploy onnistuu yhdellä
 * `cdk deploy --all -c env=prod -c wafEnabled=true` -komennolla.
 *
 * Esivaatimus: `cdk bootstrap aws://<tili>/us-east-1` (cross-region-viittaus
 * kirjoittaa arvon us-east-1:n SSM-parametriin).
 */

import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

import type { AppContext } from './config';
import { resourceName } from './config';

export interface WafStackProps extends cdk.StackProps {
  appContext: AppContext;
}

/** AWS:n hallinnoimat sääntöryhmät (yleisin suojaus, matala väärien hälytysten määrä). */
const MANAGED_RULES = [
  'AWSManagedRulesCommonRuleSet',
  'AWSManagedRulesKnownBadInputsRuleSet',
  'AWSManagedRulesAmazonIpReputationList',
];

export class WafStack extends cdk.Stack {
  /** CloudFront-jakeluun kytkettävä WebACL-ARN. */
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, {
      ...props,
      // CloudFront-scope WebACL luodaan aina us-east-1:een.
      env: { account: props.env?.account, region: 'us-east-1' },
      // Sallii WebACL-ARN:n viennin eu-north-1:ssä sijaitsevalle FrontendStackille.
      crossRegionReferences: true,
      description: 'Tampere360 WAF (CloudFront, us-east-1)',
    });

    const { appContext } = props;
    const metricName = resourceName(appContext.envName, 'cloudfront').replace(/-/g, '');

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: resourceName(appContext.envName, 'cloudfront'),
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName,
        sampledRequestsEnabled: true,
      },
      rules: MANAGED_RULES.map((ruleName, index) => ({
        name: ruleName,
        priority: index + 1,
        // managedRuleGroupStatement + overrideAction: hallinnoitu sääntöryhmä
        // toimii omalla toiminnallaan (block), overriden kautta ei muuteta.
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: { vendorName: 'AWS', name: ruleName },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${metricName}${index + 1}`,
          sampledRequestsEnabled: true,
        },
      })),
    });

    this.webAclArn = webAcl.attrArn;

    new cdk.CfnOutput(this, 'WebAclArn', { value: this.webAclArn });
  }
}
