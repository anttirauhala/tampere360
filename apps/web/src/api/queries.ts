/** TanStack Query -hookit: välimuisti, taustapäivitykset, pollaus (§10–11). */

import { useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type {
  Category,
  MapResponse,
  SituationDetail,
  SituationListResponse,
  SourceHealthResponse,
} from './types';

/** Pollausväli: aktiivinen tilannekuva päivittyy 30 sekunnin välein. */
const POLL_MS = 30_000;

export interface SituationQuery {
  category?: Category | undefined;
  status?: string | undefined;
  area?: string | undefined;
  limit?: number | undefined;
}

export function useSituations(query: SituationQuery = {}) {
  return useQuery({
    queryKey: ['situations', query],
    queryFn: () =>
      apiGet<SituationListResponse>('/v1/situations', {
        category: query.category,
        status: query.status ?? 'ACTIVE',
        area: query.area,
        limit: query.limit ?? 100,
      }),
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });
}

export function useSituation(id: string | undefined) {
  return useQuery({
    queryKey: ['situation', id],
    queryFn: () => apiGet<SituationDetail>(`/v1/situations/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useMapFeatures() {
  return useQuery({
    queryKey: ['map'],
    queryFn: () => apiGet<MapResponse>('/v1/map'),
    refetchInterval: POLL_MS,
  });
}

export function useSourceHealth() {
  return useQuery({
    queryKey: ['source-health'],
    queryFn: () => apiGet<SourceHealthResponse>('/v1/health/sources'),
    refetchInterval: 60_000,
  });
}
