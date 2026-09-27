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
  StopFeatureCollection,
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
import {
  type DelayTone,
  delayLabel,
  delayTone,
  formatVehicleAge,
  vehicleTitle,
} from '../lib/vehicles';

/** Viiveen sävy → CSS-luokka (tyylit: `styles.css` → "Kartan popupit"). */
const DELAY_TONE_CLASS: Record<DelayTone, string> = {
  ontime: 'is-ontime',
  late: 'is-late',
  early: 'is-early',
  unknown: 'is-unknown',
};

/**
 * MapLibre GL JS -kartta (§11). Tiililähteenä OpenStreetMap-rasteritiilet —
 * attribuutio näytetään kartalla (MapLibren oma attributionControl) ja
 * sovelluksen footerissa.
 *
 * Kartalla on kolme erillistä sisältöä:
 *  - tilanteet pisteinä (DOM-markerit)
 *  - ajoneuvot **yhdestä GeoJSON-lähteestä** (§27), jonka päällä on kaksi
 *    symbolikerrosta: ajoneuvon runko (kiertyy suunnan mukaan) ja
 *    linjanumerotunniste. Linjanumero piirretään ikoniin canvasilla, koska
 *    tekstikerros vaatisi glyph-lähteen, jota rasteritiilistylessämme ei ole.
 *  - pysäkit **yhdestä GeoJSON-lähteestä** (§28) MapLibren omalla
 *    klusteroinnilla: klusterit ympyröinä, joissa pysäkkien lukumäärä
 *    tekstinä, ja yksittäiset pysäkit pieninä ympyröinä. Pysäkkikerrokset
 *    lisätään ajoneuvokerrosten **alle**, jotta liikkuva kalusto pysyy
 *    luettavimpana.
 */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  /**
   * Glyph-lähde klusterien lukumäärätekstiä varten.
   *
   * MapLibren `text-field` vaatii fonttipaketit. Origin on jo sallittu CSP:ssä
   * karttatiilien takia (`infra/lib/csp.ts` → TILE_ORIGINS), joten tämä ei
   * vaadi uutta originia eikä uutta riippuvuutta. Jos glyphit eivät lataudu,
   * klusteriympyrät piirtyvät silti — vain lukumäärä jää puuttumaan.
   */
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
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

/** Pysäkkikerrokset (§28): yksi lähde, klusterit + yksittäiset pysäkit. */
const STOP_SOURCE_ID = 'stops';
const STOP_CLUSTER_LAYER = 'stops-clusters';
const STOP_CLUSTER_COUNT_LAYER = 'stops-cluster-count';
const STOP_POINT_LAYER = 'stops-points';
const STOP_SELECTED_LAYER = 'stops-selected';
/**
 * Klusterit hajoavat tällä zoomilla: sen yläpuolella näytetään yksittäiset
 * pysäkit. Tampereen keskustassa zoom 15 erottaa jo vierekkäiset laiturit.
 */
const STOP_CLUSTER_MAX_ZOOM = 14;
/** Klusteriympyrän ja lukumäärän väri — erottuu ajoneuvojen vihreästä/sinisestä. */
const STOP_CLUSTER_COLOR = '#f59e0b';

/** Tyhjä GeoJSON, jotta lähde voidaan luoda ennen ensimmäistä dataa. */
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] } as const;

interface Props {
  /** Tilanteet pisteinä (Kartta-välilehti). */
  features?: MapFeature[];
  /** Ajoneuvot (Nysse kartalla -välilehti, §27). */
  vehicles?: VehicleFeatureCollection | null;
  /** Pysäkit (vain kun "Näytä pysäkit" on valittu, §28). */
  stops?: StopFeatureCollection | null;
  /** Valittu pysäkki korostetaan kartalla (`null` = ei valintaa). */
  selectedStopId?: string | null;
  /** Kutsutaan, kun käyttäjä klikkaa yksittäistä pysäkkiä. */
  onSelectStop?: (stopId: string) => void;
}

export function MapView({ features, vehicles, stops, selectedStopId, onSelectStop }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  /** Jo rekisteröidyt linjanumerotunnisteet (yksi kuva per muoto + linja). */
  const tagIconsRef = useRef<Set<string>>(new Set());
  /** Onko kerroskohtaiset hiirikuuntelijat jo rekisteröity tähän karttaan. */
  const listenersRegisteredRef = useRef(false);
  /** Sama pysäkkikerroksille (§28) — oma lippu, koska kerrokset ovat eri efektissä. */
  const stopListenersRegisteredRef = useRef(false);
  /**
   * Klikkauksen takaisinkutsu refissä: kuuntelijat rekisteröidään kerran, joten
   * suora prop-viittaus jäisi ensimmäisen renderöinnin versioon (vanhentunut
   * sulkeuma). Ref päivittyy jokaisella renderöinnillä.
   */
  const onSelectStopRef = useRef(onSelectStop);
  onSelectStopRef.current = onSelectStop;

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

    // Karttakontrollit sijoitetaan **vasemmalle**, koska pysäkin sidepanel (§28)
    // avautuu kartan oikeaan reunaan ja peittäisi oikean reunan kontrollit
    // alleen (MapLibren `.maplibregl-ctrl-*`-säiliöllä on z-index 2, joten
    // paneelin sulkunappi jäi aiemmin zoom-painikkeiden alle eikä toiminut).
    map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-left');
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
        `<div class="map-popup"><p class="map-popup__title">${escapeHtml(
          sanitizeText(feature.properties.title),
        )}</p></div>`,
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

  // Pysäkit (§28): oma lähde klusteroituna. Kerrokset luodaan kerran ja data
  // päivitetään `setData`:lla, kuten ajoneuvoissa. Pysäkit eivät kosketa
  // kartan näkymään (ei fitBoundsia) eikä ajoneuvojen kerroksiin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    /** Pysäkkikerrokset lisätään ajoneuvokerrosten alle, jos ne ovat jo olemassa. */
    const beforeId = (): string | undefined =>
      map.getLayer(VEHICLE_BODY_LAYER) ? VEHICLE_BODY_LAYER : undefined;

    const ensureLayers = (): void => {
      if (map.getSource(STOP_SOURCE_ID)) return;

      map.addSource(STOP_SOURCE_ID, {
        type: 'geojson',
        data: EMPTY_COLLECTION as never,
        // MapLibren oma klusterointi: klusterit lasketaan selaimessa, joten
        // kartta ei tarvitse yhtään pyyntöä zoomauksen tai siirron yhteydessä.
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: STOP_CLUSTER_MAX_ZOOM,
        clusterMinPoints: 2,
      });

      // Klusterin ympyrä: koko kasvaa pysäkkien määrän mukaan.
      map.addLayer(
        {
          id: STOP_CLUSTER_LAYER,
          type: 'circle',
          source: STOP_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': STOP_CLUSTER_COLOR,
            'circle-opacity': 0.9,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#0b1220',
            'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 50, 21, 200, 26],
          },
        },
        beforeId(),
      );

      // Klusterin lukumäärä tekstinä (`point_count_abbreviated` lyhentää isot
      // luvut, esim. "1.2k"). Vaatii glyph-lähteen (ks. OSM_STYLE).
      map.addLayer(
        {
          id: STOP_CLUSTER_COUNT_LAYER,
          type: 'symbol',
          source: STOP_SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['step', ['get', 'point_count'], 11, 50, 12, 200, 13],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#0b1220' },
        },
        beforeId(),
      );

      // Yksittäinen pysäkki: pieni valkoinen ympyrä (ajoneuvot ovat värillisiä
      // ikoneita linjanumerolla, joten pysäkit erottuvat selvästi).
      map.addLayer(
        {
          id: STOP_POINT_LAYER,
          type: 'circle',
          source: STOP_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': '#ffffff',
            'circle-opacity': 0.95,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#0b1220',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5],
          },
        },
        beforeId(),
      );

      // Valittu pysäkki: korostusrengas (filtteri päivitetään `applyData`ssa).
      map.addLayer(
        {
          id: STOP_SELECTED_LAYER,
          type: 'circle',
          source: STOP_SOURCE_ID,
          filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], '']],
          paint: {
            'circle-color': 'rgba(77, 163, 255, 0.35)',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#4da3ff',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 7, 16, 11],
          },
        },
        beforeId(),
      );
    };

    const applyData = (): void => {
      const source = map.getSource(STOP_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;
      source.setData((stops ?? EMPTY_COLLECTION) as never);

      // Korostus tehdään filtterillä: valinnan vaihtaminen ei vaadi uuden
      // GeoJSON-aineiston lähettämistä työntekijälle.
      if (map.getLayer(STOP_SELECTED_LAYER)) {
        map.setFilter(STOP_SELECTED_LAYER, [
          'all',
          ['!', ['has', 'point_count']],
          ['==', ['get', 'id'], selectedStopId ?? ''],
        ]);
      }
    };

    /** Klusterin klikkaus zoomaa klusterin sisältöön — paneelia ei avata. */
    const onClusterClick = (event: MapLayerMouseEvent): void => {
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.['cluster_id'] as number | undefined;
      const coordinates = (feature?.geometry as { coordinates?: [number, number] } | undefined)
        ?.coordinates;
      if (clusterId === undefined || !coordinates) return;

      const source = map.getSource(STOP_SOURCE_ID) as GeoJSONSource | undefined;
      void source
        ?.getClusterExpansionZoom(clusterId)
        .then((zoom) => {
          // Pieni lisäys, jotta klusteri varmasti hajoaa: rajazoomilla se voisi
          // jäädä vielä kasaan ja klikkaus tuntuisi toimimattomalta.
          map.easeTo({ center: coordinates, zoom: zoom + 0.2, duration: 500 });
        })
        .catch(() => {
          // Hajotuszoomia ei saatu — ei kaadeta UI:ta sen takia.
        });
    };

    const onStopClick = (event: MapLayerMouseEvent): void => {
      const stopId = event.features?.[0]?.properties?.['id'] as string | undefined;
      if (stopId) onSelectStopRef.current?.(stopId);
    };

    const onEnter = (): void => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = (): void => {
      map.getCanvas().style.cursor = '';
    };

    /**
     * Kuuntelijat rekisteröidään kerrosten luonnin yhteydessä (sama opetus kuin
     * §27.1.1:ssä): eri efektissä tehty rekisteröinti voisi jäädä väliin, jos
     * kerrosta ei vielä olisi olemassa — ja silloin klikkaus ei toimisi koskaan.
     */
    const registerListeners = (): void => {
      if (stopListenersRegisteredRef.current || !map.getLayer(STOP_POINT_LAYER)) return;
      map.on('click', STOP_CLUSTER_LAYER, onClusterClick);
      map.on('click', STOP_POINT_LAYER, onStopClick);
      map.on('mouseenter', STOP_CLUSTER_LAYER, onEnter);
      map.on('mouseleave', STOP_CLUSTER_LAYER, onLeave);
      map.on('mouseenter', STOP_POINT_LAYER, onEnter);
      map.on('mouseleave', STOP_POINT_LAYER, onLeave);
      stopListenersRegisteredRef.current = true;
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
    };
  }, [stops, selectedStopId]);

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

/**
 * Ajoneuvon popup: linja, määränpää, viive ja havainnon ikä.
 *
 * Sisältö on jäsennelty luokilla (`map-popup__*`), jotta tyylittely on
 * `styles.css`issä eikä HTML-merkkijonossa. Tämä on myös korjaus
 * luettavuuteen: MapLibren oletus-CSS tekee valkoisen popup-laatikon mutta ei
 * aseta tekstin väriä, joten pelkkä `<strong>`/`<div>` otti värin bodysta ja
 * jäi valkoiselle taustalle (ks. `styles.css` → "Kartan popupit").
 */
function vehiclePopupHtml(properties: VehicleProperties): string {
  const rows = [
    `<p class="map-popup__title">${escapeHtml(sanitizeText(vehicleTitle(properties)))}</p>`,
    `<p class="map-popup__delay ${DELAY_TONE_CLASS[delayTone(properties.delaySeconds)]}">${escapeHtml(
      delayLabel(properties.delaySeconds),
    )}</p>`,
  ];
  if (properties.origin) {
    rows.push(
      `<p class="map-popup__row"><span class="map-popup__label">Lähtö:</span> <span class="map-popup__value">${escapeHtml(
        sanitizeText(properties.origin),
      )}</span></p>`,
    );
  }
  const age = formatVehicleAge(properties.recordedAt);
  if (age) {
    rows.push(`<p class="map-popup__row">Havaittu ${escapeHtml(age)}</p>`);
  }
  return `<div class="map-popup">${rows.join('')}</div>`;
}
