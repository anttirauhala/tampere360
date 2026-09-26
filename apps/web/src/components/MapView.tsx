import { useEffect, useRef } from 'react';
import {
  AttributionControl,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type {
  MapFeature,
  VehicleFeatureCollection,
  VehicleMode,
  VehicleProperties,
} from '../api/types';
import { sanitizeText } from '../lib/format';
// Sivutuonti: asettaa MapLibren työntekijän URL:in ennen kartan luontia
// (pakollinen, ks. lib/maplibre-worker.ts).
import '../lib/maplibre-worker';
import {
  ICON_PIXEL_RATIO,
  bodyIconId,
  createBodyIcon,
  createLineTagIcon,
  lineTagIconId,
} from '../lib/vehicle-icons';
import { delayLabel, formatVehicleAge, vehicleTitle } from '../lib/vehicles';

/**
 * MapLibre GL JS -kartta (§11). Tiililähteenä OpenStreetMap-rasteritiilet —
 * attribuutio näytetään kartalla (MapLibren oma attributionControl) ja
 * sovelluksen footerissa.
 *
 * Kartalla on kaksi erillistä sisältöä:
 *  - tilanteet pisteinä (DOM-markerit)
 *  - ajoneuvot **yhdestä GeoJSON-lähteestä** (§27), jonka päällä on kaksi
 *    symbolikerrosta: ajoneuvon runko (kiertyy suunnan mukaan) ja
 *    linjanumerotunniste. Linjanumero piirretään ikoniin canvasilla, koska
 *    tekstikerros vaatisi glyph-lähteen, jota rasteritiilistylessämme ei ole.
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

const VEHICLE_SOURCE_ID = 'vehicles';
const VEHICLE_BODY_LAYER = 'vehicles-body';
const VEHICLE_TAG_LAYER = 'vehicles-tag';
/** Tyhjä GeoJSON, jotta lähde voidaan luoda ennen ensimmäistä dataa. */
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] } as const;

interface Props {
  /** Tilanteet pisteinä (Kartta-välilehti). */
  features?: MapFeature[];
  /** Ajoneuvot (Nysse kartalla -välilehti, §27). */
  vehicles?: VehicleFeatureCollection | null;
}

export function MapView({ features, vehicles }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  /** Jo rekisteröidyt linjanumerotunnisteet (yksi kuva per muoto + linja). */
  const tagIconsRef = useRef<Set<string>>(new Set());
  /** Onko kerroskohtaiset hiirikuuntelijat jo rekisteröity tähän karttaan. */
  const listenersRegisteredRef = useRef(false);

  // Alusta kartta kerran
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: OSM_STYLE,
      center: CENTER,
      zoom: 11,
      // MapLibren oletusattribuutio pois: lisäämme oman kompaktin kontrollin,
      // jotta attribuutioita ei ole kahta päällekkäin.
      attributionControl: false,
    });

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }));
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Päivitä tilannemarkerit kun data muuttuu
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !features) return;

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

  // Ajoneuvot (§27): lähde ja kerrokset luodaan kerran, data päivitetään
  // setData:lla. HUOM: ajoneuvot EIVÄT kutsu fitBoundsia — muuten kartta
  // hyppisi 5 sekunnin välein liikkuvan kaluston mukana.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const registerTagIcon = (mode: VehicleMode, line: string): void => {
      const id = lineTagIconId(mode, line);
      if (map.hasImage(id) || tagIconsRef.current.has(id)) return;
      tagIconsRef.current.add(id);
      map.addImage(id, createLineTagIcon(line, mode), { pixelRatio: ICON_PIXEL_RATIO });
    };

    const ensureLayers = (): void => {
      if (map.getSource(VEHICLE_SOURCE_ID)) return;

      map.addImage(bodyIconId('TRAM'), createBodyIcon('TRAM'), { pixelRatio: ICON_PIXEL_RATIO });
      map.addImage(bodyIconId('BUS'), createBodyIcon('BUS'), { pixelRatio: ICON_PIXEL_RATIO });

      map.addSource(VEHICLE_SOURCE_ID, {
        type: 'geojson',
        // `as never`: MapLibren tyypit odottavat @types/geojson-namespacea, jota
        // web-paketin tsconfig ei tuo näkyviin. Data on rakenteeltaan samaa.
        data: EMPTY_COLLECTION as never,
      });

      map.addLayer({
        id: VEHICLE_BODY_LAYER,
        type: 'symbol',
        source: VEHICLE_SOURCE_ID,
        minzoom: 10,
        layout: {
          'icon-image': ['match', ['get', 'mode'], 'TRAM', bodyIconId('TRAM'), bodyIconId('BUS')],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.75, 13, 1, 16, 1.25],
          'icon-rotate': ['coalesce', ['get', 'bearing'], 0],
          // Kierto kartan koordinaatistossa: bearing 0 = pohjoinen = ylös.
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });

      map.addLayer({
        id: VEHICLE_TAG_LAYER,
        type: 'symbol',
        source: VEHICLE_SOURCE_ID,
        minzoom: 10,
        layout: {
          'icon-image': ['concat', 'vehicle-tag-', ['get', 'mode'], '-', ['get', 'line']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.85, 14, 1, 16, 1.1],
          // Tunniste ei kierry kulkusuunnan mukaan, jotta numero pysyy luettavana.
          'icon-rotation-alignment': 'viewport',
          'icon-offset': [0, -17],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    };

    const applyData = (): void => {
      const source = map.getSource(VEHICLE_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;
      for (const feature of vehicles?.features ?? []) {
        registerTagIcon(feature.properties.mode, feature.properties.line);
      }
      source.setData((vehicles ?? EMPTY_COLLECTION) as never);
    };

    const onClick = (event: MapLayerMouseEvent): void => {
      const properties = event.features?.[0]?.properties as VehicleProperties | undefined;
      if (!properties) return;
      new Popup({ offset: 14 })
        .setLngLat(event.lngLat)
        .setHTML(vehiclePopupHtml(properties))
        .addTo(map);
    };
    const onEnter = (): void => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = (): void => {
      map.getCanvas().style.cursor = '';
    };

    /**
     * Kerroskohtaiset kuuntelijat rekisteröidään vasta kun kerros on olemassa.
     *
     * Tämä on sama efekti joka luo kerroksen, ja `setup` ajetaan sekä
     * `load`-tapahtuman jälkeen että jokaisella datapäivityksellä — siksi
     * rekisteröinti ei jää väliin silloinkaan, kun kerrosta ei vielä ollut
     * (aiemmin kuuntelijat jäivät rekisteröitymättä, jos kerros puuttui
     * rekisteröintihetkellä, eikä klikkaus sen vuoksi avannut popupia).
     */
    const registerListeners = (): void => {
      if (listenersRegisteredRef.current || !map.getLayer(VEHICLE_BODY_LAYER)) return;
      map.on('click', VEHICLE_BODY_LAYER, onClick);
      map.on('mouseenter', VEHICLE_BODY_LAYER, onEnter);
      map.on('mouseleave', VEHICLE_BODY_LAYER, onLeave);
      listenersRegisteredRef.current = true;
    };

    const setup = (): void => {
      ensureLayers();
      applyData();
      registerListeners();
    };

    if (map.isStyleLoaded()) setup();
    else map.once('load', setup);

    return () => {
      map.off('load', setup);
      // Kuuntelijoita ei poisteta datapäivityksissä: ne ovat kerroskohtaisia
      // ja kartan `remove()` siivoaa ne, kun komponentti puretaan.
    };
  }, [vehicles]);

  return <div className="map" ref={containerRef} role="application" aria-label="Kartta" />;
}

/** Turvallinen HTML-escape popup-sisältöön. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Ajoneuvon popup: linja, määränpää, viive ja havainnon ikä. */
function vehiclePopupHtml(properties: VehicleProperties): string {
  const rows = [
    `<strong>${escapeHtml(sanitizeText(vehicleTitle(properties)))}</strong>`,
    `<div>${escapeHtml(delayLabel(properties.delaySeconds))}</div>`,
  ];
  if (properties.origin) {
    rows.push(`<div>Lähtö: ${escapeHtml(sanitizeText(properties.origin))}</div>`);
  }
  const age = formatVehicleAge(properties.recordedAt);
  if (age) rows.push(`<div>Havaittu ${escapeHtml(age)}</div>`);
  return rows.join('');
}
