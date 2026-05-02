import { HOUSE } from '../config';
import { rdToLocal } from './coords';

export interface Parcel {
  id: string;
  /** Polygon rings in lokale scene-coords (X=oost, -Z=noord). Outer ring = ring[0]. */
  rings: Array<Array<{ x: number; z: number }>>;
  /** Originele RD-coords. */
  rdRings: Array<Array<{ x: number; y: number }>>;
  /** Centroïde (gemiddelde van outer ring). */
  centerLocal: { x: number; z: number };
  /** Bbox in RD-coords. */
  bboxRd: { minX: number; minY: number; maxX: number; maxY: number };
  /** Optioneel: kadastrale aanduiding zoals "GEMEENTE A 1234". */
  label?: string;
  /** Of dit perceel het huis bevat (HOUSE_RD valt in outer ring). */
  containsHouse: boolean;
}

interface PdokFeature {
  id?: string;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
  properties?: Record<string, unknown>;
}

const CACHE_KEY = `parcels-near:${HOUSE.rd.x},${HOUSE.rd.y}:r40`;
const CACHE_VERSION = 2;
const SELECTION_KEY = `parcel-selection:${HOUSE.rd.x},${HOUSE.rd.y}`;

/**
 * Haalt alle kadastrale percelen op binnen ~40m van het huis.
 * Een Saksische boerderij-tuin bestaat vaak uit meerdere percelen
 * (hoofd-pand + strookjes), dus de gebruiker kiest welke bij zijn erf horen.
 */
export async function fetchNearbyParcels(): Promise<Parcel[]> {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { v: number; data: Parcel[] };
      if (parsed.v === CACHE_VERSION) return parsed.data;
    } catch {
      // negeer
    }
  }

  const r = 40; // 80×80m bbox rond huis
  const bboxStr = `${HOUSE.rd.x - r},${HOUSE.rd.y - r},${HOUSE.rd.x + r},${HOUSE.rd.y + r}`;
  const url =
    `/api/pdok-kadaster/collections/perceel/items?` +
    `bbox=${bboxStr}` +
    `&bbox-crs=http://www.opengis.net/def/crs/EPSG/0/28992` +
    `&crs=http://www.opengis.net/def/crs/EPSG/0/28992` +
    `&limit=50&f=json`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`PDOK Kadaster ${resp.status}`);
  const data = await resp.json();
  const features: PdokFeature[] = data.features ?? [];

  const parcels: Parcel[] = [];
  const target = { x: HOUSE.rd.x, y: HOUSE.rd.y };

  for (const f of features) {
    const polyList = featureToPolygons(f);
    polyList.forEach((rdPolyRings, polyIdx) => {
      const rings = rdPolyRings.map((ring) =>
        ring.map(([x, y]) => {
          const [lx, , lz] = rdToLocal(x, y, 0);
          return { x: lx, z: lz };
        }),
      );
      const rdRings = rdPolyRings.map((ring) => ring.map(([x, y]) => ({ x, y })));
      const outer = rings[0];
      const centerLocal = {
        x: outer.reduce((s, p) => s + p.x, 0) / outer.length,
        z: outer.reduce((s, p) => s + p.z, 0) / outer.length,
      };
      const containsHouse = pointInRingXY(rdRings[0], target.x, target.y);
      const id =
        polyList.length > 1
          ? `${f.id ?? f.properties?.['identificatieLokaalID']}#${polyIdx}`
          : String(f.id ?? f.properties?.['identificatieLokaalID'] ?? `unknown-${parcels.length}`);
      const label = formatLabel(f.properties);
      parcels.push({
        id,
        rings,
        rdRings,
        centerLocal,
        bboxRd: bboxOf(rdRings[0]),
        label,
        containsHouse,
      });
    });
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, data: parcels }));
  } catch {
    // ignore
  }
  return parcels;
}

function formatLabel(props: Record<string, unknown> | undefined): string | undefined {
  if (!props) return undefined;
  const akr =
    (props['kadastraleAanduiding'] as string | undefined) ??
    (props['kadastrale_aanduiding'] as string | undefined);
  if (akr) return akr;
  const sectie = props['sectie'] as string | undefined;
  const num = props['perceelnummer'] as number | string | undefined;
  if (sectie && num) return `${sectie} ${num}`;
  return undefined;
}

function featureToPolygons(f: PdokFeature): number[][][][] {
  if (f.geometry.type === 'Polygon') {
    return [f.geometry.coordinates as number[][][]];
  }
  return f.geometry.coordinates as number[][][][];
}

function pointInRingXY(ring: Array<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x,
      yi = ring[i].y;
    const xj = ring[j].x,
      yj = ring[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function bboxOf(ring: Array<{ x: number; y: number }>) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Point-in-polygon test in lokale coords. Houdt rekening met holes. */
export function pointInParcel(parcel: Parcel, x: number, z: number): boolean {
  if (!pointInLocalRing(parcel.rings[0], x, z)) return false;
  for (let i = 1; i < parcel.rings.length; i++) {
    if (pointInLocalRing(parcel.rings[i], x, z)) return false;
  }
  return true;
}

function pointInLocalRing(ring: Array<{ x: number; z: number }>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x,
      zi = ring[i].z;
    const xj = ring[j].x,
      zj = ring[j].z;
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Lijst van geselecteerde perceel-IDs (uit localStorage). */
export function loadParcelSelection(): string[] | null {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

export function saveParcelSelection(ids: string[]): void {
  localStorage.setItem(SELECTION_KEY, JSON.stringify(ids));
}
