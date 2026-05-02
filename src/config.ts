/**
 * Locatie-configuratie. Default: Kloosterstraat 9, Eext.
 * Kan via de adres-zoeker overschreven worden — opgeslagen in localStorage.
 */

export interface ZonLocation {
  address: string;
  bagAdresseerbaarobjectId: string | null;
  wgs84: { lat: number; lon: number };
  rd: { x: number; y: number };
}

const DEFAULT_LOCATION: ZonLocation = {
  address: 'Kloosterstraat 9, 9463PR Eext',
  bagAdresseerbaarobjectId: '1680010000011244',
  wgs84: { lat: 53.01749384, lon: 6.73640384 },
  rd: { x: 245538, y: 559798 },
};

const LOC_KEY = 'current-location';

/** Lees actieve locatie uit localStorage, fallback default. */
function loadLocation(): ZonLocation {
  try {
    const raw = localStorage.getItem(LOC_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ZonLocation;
      if (parsed && parsed.rd && parsed.wgs84) return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_LOCATION;
}

/**
 * Sla nieuwe locatie op + reload de pagina.
 * Niet-locatie-gekoppelde caches (PV-state, custom polygon) worden gewist.
 */
export function setLocation(loc: ZonLocation): void {
  localStorage.setItem(LOC_KEY, JSON.stringify(loc));
  // Adres-specifieke state die NIET via location-keyed cache loopt
  for (const k of [
    'pv-roof-pct',
    'pv-roof-zones',
    'pv-excluded-roof-faces',
    'custom-polygon',
  ]) {
    localStorage.removeItem(k);
  }
  // Hard reload zodat alle modules de nieuwe HOUSE inlezen
  window.location.reload();
}

export function resetToDefaultLocation(): void {
  setLocation(DEFAULT_LOCATION);
}

/** Het actieve huis-coördinaat. Eén keer geladen bij module-init. */
export const HOUSE: ZonLocation = loadLocation();

export const SCENE = {
  bagBboxRadiusM: 60,
  aerialBboxRadiusM: 100,
  aerialPixelSize: 2048,
  groundSizeM: 200,
  shadowMapSize: 4096,
  shadowFrustumM: 150,
} as const;

export const PV_DEFAULTS = {
  pricePerWp: 1.5,
  electricityPricePerKwh: 0.32,
  panelEfficiencyOfArea: 0.2,
} as const;
