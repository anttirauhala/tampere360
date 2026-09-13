/**
 * CloudWatch-mittariapurit.
 *
 * Upotettu mittariformaatti (Embedded Metric Format, EMF): CloudWatch
 * muuntaa lokirivin automaattisesti mittariksi ilman erillistä agenttia.
 */

export type MetricUnit =
  | 'Count'
  | 'Milliseconds'
  | 'Seconds'
  | 'Bytes'
  | 'Percent'
  | 'None';

export interface MetricDatum {
  name: string;
  value: number;
  unit?: MetricUnit;
}

/**
 * Julkaise mittareita EMF-muodossa (stdout → CloudWatch Logs → mittarit).
 *
 * @param namespace Mittariavaruus, esim. "Tampere360/Ingestion"
 * @param metrics Julkaistavat mittarit
 * @param dimensions Ulottuvuudet, esim. { source: 'FMI_CAP' }
 */
export function logMetrics(
  namespace: string,
  metrics: MetricDatum[],
  dimensions: Record<string, string> = {},
): void {
  if (metrics.length === 0) return;

  const dimensionNames = Object.keys(dimensions);
  const payload: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: dimensionNames.length > 0 ? [dimensionNames] : [],
          Metrics: metrics.map((metric) => ({
            Name: metric.name,
            Unit: metric.unit ?? 'None',
          })),
        },
      ],
    },
    ...dimensions,
  };
  for (const metric of metrics) {
    payload[metric.name] = metric.value;
  }

  console.log(JSON.stringify(payload));
}
