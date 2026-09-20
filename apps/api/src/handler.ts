/**
 * api — Query-Lambda API Gateway HTTP API (arkkitehtuuri §10).
 *
 * Reitit:
 *   GET /v1/situations?category=&status=&area=&limit=&cursor=
 *   GET /v1/situations/{id}
 *   GET /v1/map, /v1/categories, /v1/sources, /v1/health/sources
 *
 * Cursor-pohjainen sivutus (ei offset). Kyselyt DynamoDB GSI:n kautta.
 * HUOM: GSI:n lajitteluavain `startsAt` on **järjestysaika**, ei tapahtuman
 * alkuaika — tapahtuman oikea alkuaika luetaan kentästä event.validity.startsAt
 * ja se on null, kun lähde ei kerro sitä.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { createLogger } from '@tampere360/observability';
import type { APIGatewayProxyResultV2, APIGatewayProxyEventV2 } from 'aws-lambda';

const logger = createLogger({ service: 'api', environment: process.env['ENVIRONMENT'] ?? 'dev' });
const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);
const CATEGORIES = ['TRAFFIC','PUBLIC_TRANSPORT','POLICE','RESCUE','WEATHER','EVENT','RAIL'];

async function hSituations(path: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const sidMatch = path.match(/^\/v1\/situations\/(.+)$/);
  if (sidMatch) {
    const r = await doc.send(new GetCommand({
      TableName: process.env['SITUATIONS_TABLE_NAME'],
      Key: { situationId: sidMatch[1] },
    }));
    if (!r.Item) return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"NOT_FOUND"}' };
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.Item) };
  }
  const qs = new URLSearchParams(
    Object.entries(event.queryStringParameters ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const limit = Math.min(Number(qs.get('limit')) || 50, 200);
  const cursor = qs.get('cursor');
  const category = qs.get('category');
  const status = qs.get('status') || 'ACTIVE';
  const area = qs.get('area');
  let idx: string, pkName: string, pkVal: string;
  if (category && CATEGORIES.includes(category)) {
    idx = 'gsi2-category-startsAt'; pkName = 'category'; pkVal = category;
  } else if (area) {
    idx = 'gsi3-municipality-startsAt'; pkName = 'municipality'; pkVal = area;
  } else {
    idx = 'gsi1-status-startsAt'; pkName = 'status'; pkVal = status;
  }
  const expr: Record<string, unknown> = {
    TableName: process.env['SITUATIONS_TABLE_NAME'],
    IndexName: idx,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': pkName },
    ExpressionAttributeValues: { ':pk': pkVal },
    Limit: limit,
    ScanIndexForward: false,
  };
  if (cursor) {
    try { expr.ExclusiveStartKey = JSON.parse(Buffer.from(cursor,'base64').toString()); } catch { /* ok */ }
  }
  try {
    const r = await doc.send(new QueryCommand(expr as never));
    const items = (r.Items ?? []).map((i) => ({
      situationId: i.situationId, category: i.category, severity: i.severity,
      status: i.status, municipality: i.municipality,
      // Tapahtuman alkuaika tulee tapahtumasta, EI rivin lajitteluavaimesta:
      // null = lähde ei kerro alkuaikaa (ei arvausta).
      startsAt: i.event?.validity?.startsAt ?? null,
      publishedAt: i.publishedAt ?? null,
      firstSeenAt: i.firstSeenAt ?? null,
      title: i.event?.title?.fi ?? '',
      // Infoteksti yhden rivin esitysta varten (Nyt-sivun listarivit).
      description: i.event?.description?.fi ?? null,
    }));
    const nc = r.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString('base64')
      : null;
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items, nextCursor: nc }) };
  } catch (e) {
    logger.error('DDB-virhe', { error: String(e) });
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"QUERY_FAILED"}' };
  }
}

async function hMap(): Promise<APIGatewayProxyResultV2> {
  const r = await doc.send(new QueryCommand({
    TableName: process.env['SITUATIONS_TABLE_NAME'],
    IndexName: 'gsi1-status-startsAt',
    KeyConditionExpression: '#st = :st',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':st': 'ACTIVE' },
  }));
  const features = (r.Items ?? [])
    .filter((i: Record<string, unknown>) => {
      const loc = (i.event as Record<string, unknown> | undefined)?.location as Record<string, unknown> | undefined;
      return Boolean(loc?.['latitude'] && loc?.['longitude']);
    })
    .map((i: Record<string, unknown>) => {
      const evt = i.event as Record<string, unknown>;
      const loc = evt.location as Record<string, unknown>;
      const title = evt.title as Record<string, unknown> | undefined;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [loc['longitude'], loc['latitude']] },
        properties: { situationId: i.situationId, title: title?.['fi'] ?? '', severity: i.severity },
      };
    });
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'FeatureCollection', features }) };
}

async function hCategories(): Promise<APIGatewayProxyResultV2> {
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ categories: CATEGORIES }) };
}

async function hSources(): Promise<APIGatewayProxyResultV2> {
  const r = await doc.send(new ScanCommand({ TableName: process.env['INGESTION_STATE_TABLE_NAME'] }));
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: r.Items ?? [] }) };
}

async function hHealthSources(): Promise<APIGatewayProxyResultV2> {
  const r = await doc.send(new ScanCommand({ TableName: process.env['INGESTION_STATE_TABLE_NAME'] }));
  const now = Date.now();
  const sources = (r.Items ?? []).map((i: Record<string, unknown>) => {
    const last = i.lastSuccessfulFetch ? new Date(i.lastSuccessfulFetch as string).getTime() : 0;
    return { source: i.source, status: (now - last > 30*60*1000) ? 'STALE' : (i.status ?? 'UNKNOWN'), lastSuccessfulFetch: i.lastSuccessfulFetch, itemsReceived: i.itemsReceived };
  });
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'OK', sources }) };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const path = event.rawPath ?? '';
    if (event.requestContext?.http?.method !== 'GET') {
      return { statusCode: 405, headers: { 'content-type': 'application/json' }, body: '{"error":"METHOD_NOT_ALLOWED"}' };
    }
    if (path.startsWith('/v1/situations')) return hSituations(path, event);
    if (path === '/v1/map') return hMap();
    if (path === '/v1/categories') return hCategories();
    if (path === '/v1/sources') return hSources();
    if (path === '/v1/health/sources') return hHealthSources();
    return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'NOT_FOUND', path }) };
  } catch (err) {
    logger.error('API-virhe', { error: String(err) });
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"INTERNAL_ERROR"}' };
  }
}
