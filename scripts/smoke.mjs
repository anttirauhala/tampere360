#!/usr/bin/env node
/**
 * smoke.mjs — julkaisun jälkeinen savutesti (arkkitehtuuri §15).
 *
 * Ajetaan deploy-workflowssa `cdk deploy --outputs-file`-tiedoston perusteella,
 * joten osoitteita ei ole kovakoodattu mihinkään. Lukee vain — ei kirjoita.
 *
 * Tarkistukset:
 *   1. GET <api>/v1/situations?limit=1 → 200, { items: [...] }
 *   2. GET <api>/v1/health/sources     → 200, status OK, ei yhtään ERROR-lähdettä
 *   3. GET <frontend>/                 → 200, sisältää brändin "Tampere 247"
 *   4. GET <frontend>/config.json      → 200, API:n juuri asetettu
 *      (avain `apiBaseUrl` — sama, jota apps/web/src/api/client.ts lukee)
 *
 * Käyttö:
 *   node scripts/smoke.mjs --outputs infra/cdk-outputs-dev.json --env dev
 *   node scripts/smoke.mjs --api https://... --frontend https://...
 *
 * Huom: puuttuva lähde health-vastauksessa on **varoitus**, ei virhe —
 * tuoreessa ympäristössä Schedulerit kirjaavat tilan vasta ensimmäisellä
 * ajokerralla (FMI 5 min, POLICE 2–5 min). Selkeä virhetila (ERROR) sen sijaan
 * pysäyttää savutestin.
 */

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** Lähteet, joiden pitäisi lopulta löytyä /v1/health/sources-vastauksesta. */
const EXPECTED_SOURCES = ['TAMPERE_TRAFFIC', 'FMI_CAP', 'POLICE_RSS', 'NYSSE_ALERTS'];
/** Oletusyritykset ja viive: CloudFront-invalidointi + Schedulerien ensiajo. */
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_DELAY_MS = 15_000;
/** Yksittäisen HTTP-kutsun aikakatkaisu. */
const REQUEST_TIMEOUT_MS = 20_000;

const USAGE = `Käyttö:
  node scripts/smoke.mjs [--outputs <tiedosto>] [--env dev|prod|test]
                         [--api <url>] [--frontend <url>]
                         [--attempts <n>] [--delay-ms <ms>] [--help]

Esimerkit:
  node scripts/smoke.mjs --outputs infra/cdk-outputs-dev.json --env dev
  node scripts/smoke.mjs --api https://api.tampere247.online \\
                         --frontend https://tampere247.online`;

function fail(message) {
  console.error(`\n${message}\n\n${USAGE}`);
  process.exit(2);
}

/** Lukee `--nimi arvo` ja `--nimi=arvo` -muotoiset argumentit. */
function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    // Arvottomat liput: eivät ota seuraavaa argumenttia arvokseen.
    if (raw === '--help' || raw === '-h') {
      args.set('help', 'true');
      continue;
    }
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      args.set(raw.slice(2, eq), raw.slice(eq + 1));
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`Puuttuva arvo: ${raw}`);
      args.set(raw.slice(2), value);
      i += 1;
    }
  }
  return args;
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Ratkaisee testattavat osoitteet joko `cdk deploy --outputs-file`-tiedostosta
 * (ensisijainen: custom domain, jos sellainen on) tai eksplisiittisistä
 * `--api`/`--frontend`-argumenteista.
 */
function resolveUrls(args) {
  const apiArg = args.get('api');
  const frontendArg = args.get('frontend');
  if (apiArg && frontendArg) {
    return { api: trimSlash(apiArg), frontend: trimSlash(frontendArg), source: 'argumentit' };
  }

  const env = args.get('env') ?? 'dev';
  const outputsPath = args.get('outputs') ?? `infra/cdk-outputs-${env}.json`;
  let outputs;
  try {
    outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
  } catch (err) {
    fail(`Outputs-tiedostoa ei saatu luettua: ${outputsPath} (${err.message})`);
    return undefined;
  }

  const apiStack = outputs[`tampere360-${env}-api`];
  const webStack = outputs[`tampere360-${env}-frontend`];
  if (!apiStack || !webStack) {
    const stacks = Object.keys(outputs).join(', ') || '(ei yhtään)';
    fail(
      `Outputs-tiedostosta puuttuu tampere360-${env}-api tai tampere360-${env}-frontend.\n` +
        `Tiedostossa olevat stackit: ${stacks}`,
    );
  }

  // Prodissa on custom domain (ApiCustomUrl / FrontendCustomUrl); devissä
  // käytetään API Gatewayn ja CloudFrontin oletusosoitteita.
  const api = apiStack.ApiCustomUrl ?? apiStack.ApiUrl;
  const frontend = webStack.FrontendCustomUrl ?? webStack.FrontendUrl;
  if (!api || !frontend) {
    fail(`Outputs-tiedostosta puuttui API- tai frontend-osoite (${outputsPath})`);
  }
  return { api: trimSlash(api), frontend: trimSlash(frontend), source: outputsPath };
}

async function request(url, accept) {
  const res = await fetch(url, {
    headers: { accept, 'user-agent': 'tampere360-smoke' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return res;
}

async function getJson(url) {
  const res = await request(url, 'application/json');
  return res.json();
}

async function getText(url) {
  const res = await request(url, 'text/html');
  return res.text();
}

/** 1. Tilannelista: vastauksen muoto ja että rivejä voidaan hakea. */
async function checkSituations({ api }) {
  const body = await getJson(`${api}/v1/situations?limit=1`);
  if (!Array.isArray(body.items)) throw new Error('vastauksesta puuttuu items-taulukko');
  const first = body.items[0];
  if (first && typeof first.situationId !== 'string') {
    throw new Error('ensimmäisestä rivistä puuttuu situationId');
  }
  return `${body.items.length} aktiivista riviä (limit=1)`;
}

/** 2. Lähteiden tila: ei yhtään ERROR-tilaa; puuttuvat lähteet → varoitus. */
async function checkHealth({ api }) {
  const body = await getJson(`${api}/v1/health/sources`);
  if (body.status !== 'OK') throw new Error(`health.status = ${String(body.status)}`);
  const sources = Array.isArray(body.sources) ? body.sources : [];
  const broken = sources.filter((s) => s.status === 'ERROR');
  if (broken.length > 0) {
    throw new Error(
      `lähteet virhetilassa: ${broken
        .map((s) => `${s.source}${s.error ? ` (${s.error})` : ''}`)
        .join(', ')}`,
    );
  }
  const missing = EXPECTED_SOURCES.filter((name) => !sources.some((s) => s.source === name));
  return {
    detail: `${sources.length} lähdettä, ei ERROR-tiloja`,
    warn: missing.length > 0 ? `ei vielä kirjausta: ${missing.join(', ')}` : undefined,
  };
}

/** 3. ja 4. Frontendin dokumentti ja ajonaikainen config.json. */
async function checkFrontend({ frontend }) {
  const html = await getText(`${frontend}/`);
  if (!html.includes('Tampere 247')) {
    throw new Error('etusivu ei sisällä brändiä "Tampere 247"');
  }
  // FrontendStack kirjoittaa API:n juuren avaimella `apiBaseUrl` (sama avain,
  // jota apps/web/src/api/client.ts lukee). Hyväksytään lisäksi `apiUrl`,
  // jotta nimeämisen muuttuminen ei kaada savutestiä turhaan.
  const config = await getJson(`${frontend}/config.json`);
  const apiUrl = config.apiBaseUrl ?? config.apiUrl;
  if (typeof apiUrl !== 'string' || !apiUrl.startsWith('http')) {
    throw new Error('config.json: apiBaseUrl puuttuu tai ei ole http(s)-osoite');
  }
  return `etusivu + config.json (apiBaseUrl ${apiUrl})`;
}

/** Yrittää tarkistusta uudelleen: julkaisun jälkeen CloudFront päivittyy hetken. */
async function withRetry(label, fn, attempts, delayMs) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`  · ${label}: yritys ${attempt}/${attempts} epäonnistui — ${err.message}`);
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log(USAGE);
    return;
  }

  const attempts = Number(args.get('attempts') ?? DEFAULT_ATTEMPTS);
  const delayMs = Number(args.get('delay-ms') ?? DEFAULT_DELAY_MS);
  if (!Number.isInteger(attempts) || attempts < 1) fail('--attempts on positiivinen kokonaisluku');
  if (!Number.isInteger(delayMs) || delayMs < 0) fail('--delay-ms on ei-negatiivinen kokonaisluku');

  const urls = resolveUrls(args);
  console.log(`Savutesti (${urls.source})`);
  console.log(`  API:      ${urls.api}`);
  console.log(`  Frontend: ${urls.frontend}`);
  console.log(`  Yritykset: ${attempts} × ${delayMs} ms\n`);

  const checks = [
    ['tilannelista', checkSituations],
    ['lähteiden tila', checkHealth],
    ['frontend', checkFrontend],
  ];

  const failures = [];
  for (const [label, check] of checks) {
    try {
      const result = await withRetry(label, () => check(urls), attempts, delayMs);
      if (typeof result === 'string') {
        console.log(`✔ ${label}: ${result}`);
      } else {
        console.log(`✔ ${label}: ${result.detail}`);
        if (result.warn) console.warn(`  ! ${result.warn}`);
      }
    } catch (err) {
      console.error(`✘ ${label}: ${err.message}`);
      failures.push(label);
    }
  }

  if (failures.length > 0) {
    console.error(`\nSavutesti epäonnistui: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nSavutesti läpäisty.');
}

main().catch((err) => {
  console.error(`Savutesti kaatui: ${err.stack ?? err.message}`);
  process.exit(1);
});
