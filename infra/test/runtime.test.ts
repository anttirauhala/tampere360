import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regressiosuoja Lambda-runtimelle ja kehitysympäristön Node-versiolle
 * (implementation_plan §44).
 *
 * Runtime on kirjoitettu jokaiseen funktioon erikseen (12 kpl), joten ilman
 * tätä testiä yksittäinen funktio voi jäädä vanhalle runtimelle hiljaisesti —
 * juuri niin kävi 22 → 24 -päivityksessä, jossa korvaus oli tehtävä käsin
 * kolmeen tiedostoon. Sama koskee kehitysympäristöä: `.nvmrc`, `engines` ja
 * `@types/node` on pidettävä samalla major-versiolla kuin Lambda-runtime,
 * muuten paikallinen tyyppitarkistus ja ajonaikainen ympäristö eivät enää
 * vastaa toisiaan (esim. tyypit sallisivat API:n, jota runtime ei tue).
 *
 * Testi lukee lähteet tekstitasolla (sama menetelmä kuin
 * `apps/web/src/styles.test.ts`), joten se ei vaadi CDK-synteesiä eikä
 * esbuild-bundlausta.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const INFRA_LIB = join(repoRoot, 'infra', 'lib');

/** Major-versio, jota projektissa käytetään sekä Lambdassa että paikallisesti. */
const EXPECTED_MAJOR = 24;
/**
 * Paikallisen Noden vähimmäistaso: 24.22.1 (21.10.2026) korjaa muun muassa
 * TLS/DNS/Brotli/http -haavoittuvuudet (CVE-2026-106069, -106072, -105482,
 * -111497, -105481). Vanhemmalla 24.x:llä ajo ei ole sallittua.
 */
const MIN_LOCAL_NODE: readonly number[] = [24, 22, 1];

interface PackageJson {
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
}

/** Kaikkien `infra/lib/*.ts` -tiedostojen sisältö yhtenä listana. */
function infraSources(): string[] {
  return readdirSync(INFRA_LIB)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(INFRA_LIB, name), 'utf8'));
}

/** Kaikki `runtime:`-rivit, esim. `runtime: lambda.Runtime.NODEJS_24_X,`. */
function runtimeDeclarations(): string[] {
  const pattern = /runtime:\s*([^,\n]+)/g;
  return infraSources().flatMap((source) =>
    [...source.matchAll(pattern)].map((match) => (match[1] ?? '').trim()),
  );
}

/** Runtime-konstanttien major-versiot, esim. `NODEJS_24_X` → `24`. */
function runtimeMajors(): number[] {
  const pattern = /NODEJS_(\d+)_X/g;
  return runtimeDeclarations()
    .flatMap((declaration) => [...declaration.matchAll(pattern)])
    .map((match) => Number(match[1]));
}

function parseVersion(value: string): number[] | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Palauttaa <0, 0 tai >0 (riittää major/minor/patch-vertailuun). */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
const typesNodeRange = packageJson.devDependencies?.['@types/node'] ?? '';
const typesNodeMajor = Number(typesNodeRange.match(/(\d+)/)?.[1] ?? Number.NaN);

describe('Lambda-runtime (infra/lib)', () => {
  it('jokainen funktio käyttää samaa runtime-konstanttia', () => {
    const declarations = runtimeDeclarations();
    // Jos määrä putoaa, funktioita on siirretty muualle tai `runtime:`-rivi on
    // muotoiltu uudelleen eikä testi enää valvo kaikkia funktioita.
    expect(declarations.length).toBeGreaterThanOrEqual(12);
    expect([...new Set(declarations)]).toEqual(['lambda.Runtime.NODEJS_24_X']);
  });

  it('ei käytä yhtään vanhentunutta Node-runtimea', () => {
    expect(infraSources().join('\n')).not.toMatch(/NODEJS_(14|16|18|20|22)_X/);
  });

  it('runtime on odotettu major-versio', () => {
    expect([...new Set(runtimeMajors())]).toEqual([EXPECTED_MAJOR]);
  });
});

describe('.nvmrc', () => {
  it('on tarkka versio, ei liukuva major', () => {
    expect(parseVersion(nvmrc)).not.toBeNull();
  });

  it('on vähintään tietoturvakorjaustaso 24.22.1', () => {
    const version = parseVersion(nvmrc);
    expect(version).not.toBeNull();
    expect(compareVersions(version ?? [], MIN_LOCAL_NODE)).toBeGreaterThanOrEqual(0);
  });

  it('major vastaa Lambda-runtimea', () => {
    expect(parseVersion(nvmrc)?.[0]).toBe(EXPECTED_MAJOR);
    expect([...new Set(runtimeMajors())]).toEqual([parseVersion(nvmrc)?.[0]]);
  });
});

describe('package.json', () => {
  it('engines vaatii saman major-version kuin runtime', () => {
    expect(packageJson.engines?.node).toBe(`>=${EXPECTED_MAJOR}`);
  });

  it('@types/node on samalla major-linjalla kuin runtime', () => {
    expect(typesNodeMajor).toBe(EXPECTED_MAJOR);
  });
});
