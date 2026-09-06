/**
 * api — Query-Lambda API Gateway HTTP API:lle (arkkitehtuuri §10).
 *
 * Reitit (Vaihe 2+):
 *   GET /v1/situations?category=&status=&area=&from=&to=&limit=&cursor=
 *   GET /v1/situations/{id}
 *   GET /v1/map
 *   GET /v1/categories
 *   GET /v1/sources
 *   GET /v1/health/sources
 *
 * MVP:ssä ainoastaan terveystarkistus toteutettuna; varsinaiset
 * DynamoDB-kyselyt (cursor-sivutus) toteutetaan Vaiheessa 2.
 */

import { createLogger } from '@tampere247/observability';
import type { APIGatewayProxyResultV2, APIGatewayProxyEventV2 } from 'aws-lambda';

const logger = createLogger({
  service: 'api',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath;
  logger.info('api kutsuttu', { path });

  if (path === '/v1/health/sources') {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'OK', sources: [] }),
    };
  }

  return {
    statusCode: 501,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'NOT_IMPLEMENTED', path }),
  };
}
