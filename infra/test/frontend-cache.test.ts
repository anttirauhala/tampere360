import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppContext } from '../lib/config';
import { FrontendStack } from '../lib/frontend-stack';
import {
  WEB_ASSETS_CACHE_CONTROL,
  WEB_ASSETS_PATH_PATTERN,
  WEB_ASSETS_TTL_SECONDS,
  WEB_DOCUMENT_CACHE_CONTROL,
} from '../lib/web-cache';

/**
 * Frontendin CloudFront-välimuistipolitiikat — regressiosuoja.
 *
 * Tausta (vika havaittu 27.9.2026): oletusbehavior oli `CACHING_OPTIMIZED`,
 * joten `index.html` jäi välimuistiin oletus-TTL:llä. Koska BucketDeployment
 * poistaa vanhat chunkit, kauan auki ollut välilehti törmäsi puuttuvaan
 * chunk-nimeen ja dynaaminen import kaatui
 * ("error loading dynamically imported module").
 *
 * Näiden testien tarkoitus on varmistaa, ettei dokumenttia koskaan välimuistiteta
 * ja että assetit saavat pitkän (hash-nimen salliman) TTL:n.
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

interface CacheBehavior {
  PathPattern: string;
  CachePolicyId: unknown;
  ResponseHeadersPolicyId: unknown;
}

interface DistributionConfig {
  DefaultCacheBehavior: CacheBehavior;
  DefaultRootObject: string;
  CacheBehaviors: CacheBehavior[];
  CustomErrorResponses: { ErrorCode: number; ResponseCode: number; ResponsePagePath: string }[];
}

interface CachePolicyConfig {
  Name: string;
  MinTTL: number;
  DefaultTTL: number;
  MaxTTL: number;
  ParametersInCacheKeyAndForwardedToOrigin: {
    EnableAcceptEncodingGzip: boolean;
    EnableAcceptEncodingBrotli: boolean;
  };
}

interface HeadersPolicyConfig {
  Name: string;
  CustomHeadersConfig?: { Items: { Header: string; Value: string; Override: boolean }[] };
}

interface Synthesized {
  config: DistributionConfig;
  cachePolicies: CachePolicyConfig[];
  headersPolicies: { logicalId: string; config: HeadersPolicyConfig }[];
}

/** Synteesoidaan kerran (aws-cdk-libin lataus ja synth ovat raskaita). */
let synthesized: Synthesized | null = null;

/** Synteesoi FrontendStackin tilapäisellä "buildilla" (ei tarvita vite-buildia). */
function synth(): Synthesized {
  synthesized ??= doSynth();
  return synthesized;
}

function doSynth(): Synthesized {
  const app = new cdk.App();
  const stack = new FrontendStack(app, 'TestFrontend', {
    env: { account: APP_CONTEXT.account, region: APP_CONTEXT.region },
    appContext: APP_CONTEXT,
    apiUrl: 'https://vllod80b6i.execute-api.eu-north-1.amazonaws.com',
    webDistPath: distDir,
  });

  const resources = (
    Template.fromStack(stack).toJSON() as { Resources: Record<string, TemplateResource> }
  ).Resources;

  const distribution = Object.values(resources).find(
    (resource) => resource.Type === 'AWS::CloudFront::Distribution',
  );
  if (!distribution?.Properties) {
    throw new Error('CloudFront-jakelua ei löytynyt synteesoidystä mallipohjasta');
  }

  const cachePolicies = Object.values(resources)
    .filter((resource) => resource.Type === 'AWS::CloudFront::CachePolicy')
    .map(
      (resource) =>
        (resource.Properties as { CachePolicyConfig: CachePolicyConfig }).CachePolicyConfig,
    );

  const headersPolicies = Object.entries(resources)
    .filter(([, resource]) => resource.Type === 'AWS::CloudFront::ResponseHeadersPolicy')
    .map(([logicalId, resource]) => ({
      logicalId,
      config: (resource.Properties as { ResponseHeadersPolicyConfig: HeadersPolicyConfig })
        .ResponseHeadersPolicyConfig,
    }));

  return {
    config: distribution.Properties.DistributionConfig as unknown as DistributionConfig,
    cachePolicies,
    headersPolicies,
  };
}

/** Poimii Cache-Controlin arvon otsakepolitiikasta, jota behavior käyttää. */
function cacheControlOf(
  behavior: CacheBehavior,
  headersPolicies: { logicalId: string; config: HeadersPolicyConfig }[],
): string | undefined {
  // ResponseHeadersPolicyId on `{ Ref: <looginen id> }` (sama stackki).
  const ref = resolveRef(behavior.ResponseHeadersPolicyId);
  const policy = headersPolicies.find((candidate) => ref === candidate.logicalId);
  return policy?.config.CustomHeadersConfig?.Items.find((item) => item.Header === 'Cache-Control')
    ?.Value;
}

/** Ratkaisee `{ Ref: ... }`-viittauksen saman mallipohjan resurssiin. */
function resolveRef(value: unknown): unknown {
  if (value && typeof value === 'object' && 'Ref' in (value as Record<string, unknown>)) {
    return (value as { Ref: string }).Ref;
  }
  return value;
}

let distDir = '';

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tampere360-web-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>test</title>');
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('FrontendStackin välimuistipolitiikat', () => {
  it('ei välimuistita dokumenttia (oletusbehavior on sama no-store-policy kuin config.json)', () => {
    const { config } = synth();
    const runtimeConfig = config.CacheBehaviors.find(
      (behavior) => behavior.PathPattern === 'config.json',
    );

    expect(runtimeConfig).toBeDefined();
    // Sama policy-id kuin config.jsonilla = CachingDisabled (ei välimuistiin).
    expect(config.DefaultCacheBehavior.CachePolicyId).toEqual(runtimeConfig?.CachePolicyId);
  }, 30_000);

  it('asettaa Cache-Controlin selaimelle: dokumentti ei välimuistiin, assetit vuodeksi', () => {
    // Regressiosuoja 1.10.2026: CloudFrontin managed "CachingDisabled" ei lisää
    // Cache-Control-otsaketta lainkaan, jolloin **selain** voi käyttää
    // heuristista välimuistia ja käyttää vanhaa index.html:ää (jonka chunkit on
    // jo poistettu bucketista). Siksi otsake asetetaan eksplisiittisesti.
    const { config, headersPolicies } = synth();

    const documentCacheControl = cacheControlOf(config.DefaultCacheBehavior, headersPolicies);
    expect(documentCacheControl).toBe(WEB_DOCUMENT_CACHE_CONTROL);
    expect(documentCacheControl).toContain('no-store');

    const assets = config.CacheBehaviors.find(
      (behavior) => behavior.PathPattern === WEB_ASSETS_PATH_PATTERN,
    );
    expect(assets).toBeDefined();
    const assetsCacheControl = cacheControlOf(assets as CacheBehavior, headersPolicies);
    expect(assetsCacheControl).toBe(WEB_ASSETS_CACHE_CONTROL);
    expect(assetsCacheControl).toContain('immutable');
    expect(assetsCacheControl).toContain(String(WEB_ASSETS_TTL_SECONDS));

    // config.json on dokumentin tapaan aina tuore.
    const runtimeConfig = config.CacheBehaviors.find(
      (behavior) => behavior.PathPattern === 'config.json',
    );
    expect(cacheControlOf(runtimeConfig as CacheBehavior, headersPolicies)).toBe(
      WEB_DOCUMENT_CACHE_CONTROL,
    );
  });

  it('antaa hashatuille asseteille oman pitkän TTL:n', () => {
    const { config, cachePolicies } = synth();
    const assets = config.CacheBehaviors.find(
      (behavior) => behavior.PathPattern === WEB_ASSETS_PATH_PATTERN,
    );

    expect(assets).toBeDefined();
    // Assetit eivät käytä samaa policya kuin dokumentti.
    expect(assets?.CachePolicyId).not.toEqual(config.DefaultCacheBehavior.CachePolicyId);
    // Policy on oma resurssi tässä stackissa (ei AWS:n managed-policy).
    expect(resolveRef(assets?.CachePolicyId)).toContain('WebAssetsCachePolicy');

    const policy = cachePolicies.find((candidate) => candidate.Name.includes('assets'));
    expect(policy).toBeDefined();
    expect(policy?.MinTTL).toBe(WEB_ASSETS_TTL_SECONDS);
    expect(policy?.DefaultTTL).toBe(WEB_ASSETS_TTL_SECONDS);
    expect(policy?.MaxTTL).toBe(WEB_ASSETS_TTL_SECONDS);
    expect(policy?.ParametersInCacheKeyAndForwardedToOrigin.EnableAcceptEncodingGzip).toBe(true);
    expect(policy?.ParametersInCacheKeyAndForwardedToOrigin.EnableAcceptEncodingBrotli).toBe(true);
  });

  it('TTL on vuosi (hash-nimi tekee pitkästä välimuistista turvallisen)', () => {
    expect(WEB_ASSETS_TTL_SECONDS).toBe(365 * 24 * 60 * 60);
  });

  it('säilyttää SPA-reitityksen: 403/404 → index.html', () => {
    const { config } = synth();
    expect(config.DefaultRootObject).toBe('index.html');
    const mapped = config.CustomErrorResponses.map((response) => response.ErrorCode);
    expect(mapped).toContain(403);
    expect(mapped).toContain(404);
    for (const response of config.CustomErrorResponses) {
      expect(response.ResponseCode).toBe(200);
      expect(response.ResponsePagePath).toBe('/index.html');
    }
  });
});
