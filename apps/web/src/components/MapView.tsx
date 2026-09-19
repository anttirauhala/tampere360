import { useEffect, useRef } from 'react';
import {
  AttributionControl,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { MapFeature } from '../api/types';
import { sanitizeText } from '../lib/format';

/**
 * MapLibre GL JS -kartta (§11). Tiililähteenä OpenStreetMap-rasteritiilet —
 * attribuutio näytetään kartalla (MapLibren oma attributionControl) ja
 * sovelluksen footerissa.
 */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      minzoom: 0,
      maxzoom: 22,
    },
  ],
};

/** Tampereen keskusta. */
const CENTER: [number, number] = [23.761, 61.4978];

const SEVERITY_COLOR: Record<string, string> = {
  INFO: '#3b82f6',
  MINOR: '#eab308',
  MAJOR: '#f97316',
  CRITICAL: '#dc2626',
};

interface Props {
  features: MapFeature[];
}

export function MapView({ features }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);

  // Alusta kartta kerran
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: OSM_STYLE,
      center: CENTER,
      zoom: 11,
    });

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }));
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Päivitä markerit kun data muuttuu
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current) marker.remove();
    markersRef.current = [];

    const bounds = new LngLatBounds();

    for (const feature of features) {
      const [lng, lat] = feature.geometry.coordinates;
      const color = SEVERITY_COLOR[feature.properties.severity] ?? '#3b82f6';

      const el = document.createElement('div');
      el.className = 'marker';
      el.style.background = color;
      el.title = sanitizeText(feature.properties.title);

      const popup = new Popup({ offset: 16 }).setHTML(
        `<strong>${escapeHtml(sanitizeText(feature.properties.title))}</strong>`,
      );

      const marker = new Marker({ element: el }).setLngLat([lng, lat]).setPopup(popup);
      marker.addTo(map);
      markersRef.current.push(marker);
      bounds.extend([lng, lat]);
    }

    if (features.length > 0 && !bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 600 });
    }
  }, [features]);

  return (
    <div className="map" ref={containerRef} role="application" aria-label="Tilanteiden kartta" />
  );
}

/** Turvallinen HTML-escape popup-sisältöön. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
