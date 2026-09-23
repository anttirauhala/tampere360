/** TanStack Query -hookit: välimuisti, taustapäivitykset, pollaus (§10–11). */

import { useQuery } from '@tanstack/react-query';

import { fetchCameraData, fetchCameraStations } from './cameras';
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

/**
 * Kelikamerat Digitrafficilta (suoraan selaimesta, ks. api/cameras.ts).
 *
 * Kaksi kutsua rinnakkain:
 * - `fetchCameraStations` — asemien nimet, sijainnit ja kamerat
 * - `fetchCameraData` — kameroiden todelliset kuvausajat (`measuredTime`);
 *   asemaluettelon oma `dataUpdatedTime` on metatietoa ja voi olla tunteja vanha
 *
 * Ei automaattista pollausta: kamerakuvat ovat raskaita, joten uudet kuvat
 * haetaan vain käyttäjän "Päivitä kuvat" -painikkeella tai kun välilehti
 * avataan uudelleen (oletus `refetchOnWindowFocus: true` on kytketty pois,
 * jotta välilehdelle palaaminen ei lataa kymmeniä kuvia uudelleen).
 */
export function useCameraData() {
  return useQuery({
    queryKey: ['cameras'],
    queryFn: async ({ signal }) => {
      const [stations, data] = await Promise.all([
        fetchCameraStations(signal),
        fetchCameraData(signal),
      ]);
      return { stations, data };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
