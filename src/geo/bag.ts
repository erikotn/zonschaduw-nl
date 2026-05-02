import * as THREE from 'three';
import earcut from 'earcut';
import { houseBbox, rdToLocal } from './coords';
import { HOUSE, SCENE } from '../config';

interface CityJsonTransform {
  scale: [number, number, number];
  translate: [number, number, number];
}

interface CitySemantics {
  surfaces: Array<{ type: string; [k: string]: unknown }>;
  values: unknown;
}

interface CityGeometry {
  type: 'Solid' | 'MultiSurface' | 'CompositeSolid' | string;
  lod: string;
  boundaries: unknown;
  semantics?: CitySemantics;
}

interface CityObject {
  type: 'Building' | 'BuildingPart' | string;
  geometry?: CityGeometry[];
  attributes?: Record<string, unknown>;
  parents?: string[];
  children?: string[];
}

interface CityJsonFeature {
  type: 'CityJSONFeature';
  id: string;
  CityObjects: Record<string, CityObject>;
  vertices: number[][];
  transform?: CityJsonTransform;
}

interface FeatureCollection {
  features: CityJsonFeature[];
  links?: Array<{ rel: string; href: string }>;
  metadata?: {
    transform?: CityJsonTransform;
  };
}

export interface RoofFace {
  buildingId: string;
  faceIndex: number;
  azimuthDeg: number; // BAG-conventie: 0=noord, 90=oost, 180=zuid, 270=west
  tiltDeg: number;
  ringWorld: THREE.Vector3[]; // outer ring in local scene-coords
  area: number; // m²
  /** Centroïde van de outer ring in lokale scene-coords. */
  centroidLocal: THREE.Vector3;
  isHighlightDom: HTMLDivElement | null; // placeholder voor latere annotatie
}

export interface BagResult {
  walls: THREE.BufferGeometry;
  roofs: THREE.BufferGeometry;
  roofFaces: RoofFace[];
  /** Per driehoek-index in roofs-geometrie: bijbehorende roofFaces-index. */
  roofTriangleToFace: number[];
  groundLevelNap: number;
  buildingCount: number;
}

const CACHE_KEY = `bag:${HOUSE.rd.x},${HOUSE.rd.y}:r${SCENE.bagBboxRadiusM}`;
const CACHE_VERSION = 3; // bumped: Y-shift nu pre-applied bij parse

export async function fetchBagBuildings(): Promise<BagResult> {
  const cached = localStorage.getItem(CACHE_KEY);
  let collection: FeatureCollection | null = null;

  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { v: number; data: FeatureCollection };
      if (parsed.v === CACHE_VERSION) collection = parsed.data;
    } catch {
      // negeer
    }
  }

  if (!collection) {
    const features: CityJsonFeature[] = [];
    let transform: CityJsonTransform | undefined;
    const [minx, miny, maxx, maxy] = houseBbox(SCENE.bagBboxRadiusM);
    let url: string | null = `/api/3dbag/collections/pand/items?bbox=${minx},${miny},${maxx},${maxy}&limit=100`;

    while (url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`3D BAG ${r.status}: ${await r.text()}`);
      const fc = (await r.json()) as FeatureCollection;
      features.push(...fc.features);
      transform = transform ?? fc.metadata?.transform;
      const next = fc.links?.find((l) => l.rel === 'next');
      url = next ? next.href.replace(/^https?:\/\/api\.3dbag\.nl/, '/api/3dbag') : null;
    }

    if (!transform) throw new Error('3D BAG levert geen transform op FeatureCollection-niveau');
    collection = { features, metadata: { transform } };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, data: collection }));
    } catch {
      // localStorage vol — negeer
    }
  }

  return parseFeatureCollection(collection);
}

function parseFeatureCollection(fc: FeatureCollection): BagResult {
  const transform = fc.metadata?.transform;
  if (!transform) throw new Error('Cache mist transform');

  const wallsBuilder = new GeometryBuilder();
  const roofsBuilder = new GeometryBuilder();
  const roofFaces: RoofFace[] = [];
  const roofTriangleToFace: number[] = [];

  let groundSum = 0;
  let groundCount = 0;

  for (const feature of fc.features) {
    const featureTransform = feature.transform ?? transform;
    const verts = decodeVertices(feature.vertices, featureTransform);

    for (const [coId, co] of Object.entries(feature.CityObjects)) {
      if (!co.geometry) continue;

      const geom22 = co.geometry.find((g) => g.lod === '2.2');
      if (!geom22) continue;

      // Solid: boundaries = [Shell, Shell, ...], Shell = [Surface, Surface, ...], Surface = [Ring, Ring, ...]
      // semantics.values: [[v0,v1,...]]  parallel met boundaries
      const boundaries = geom22.boundaries as number[][][][];
      const semantics = geom22.semantics;

      if (geom22.type !== 'Solid' && geom22.type !== 'MultiSurface') continue;
      const shells = geom22.type === 'Solid' ? boundaries : ([boundaries] as unknown as number[][][][]);
      const semValues =
        geom22.type === 'Solid' ? (semantics?.values as number[][] | undefined) : ([semantics?.values] as unknown as number[][]);

      shells.forEach((shell, shellIdx) => {
        shell.forEach((surface, surfaceIdx) => {
          const semIdx = semValues?.[shellIdx]?.[surfaceIdx];
          const semType = semIdx !== undefined && semIdx !== null
            ? semantics?.surfaces?.[semIdx]?.type
            : undefined;

          const rings = surface.map((ringIndices) => ringIndices.map((vi) => verts[vi]));
          if (rings.length === 0 || rings[0].length < 3) return;

          // Triangulate this face (in 3D)
          const triangles = triangulateFace(rings);
          if (triangles.length === 0) return;

          if (semType === 'RoofSurface') {
            const surfaceMeta = semantics!.surfaces[semIdx as number] as Record<string, unknown>;
            const azimuth = (surfaceMeta.b3_azimut as number) ?? azimuthFromRing(rings[0]);
            const tilt = (surfaceMeta.b3_hellingshoek as number) ?? tiltFromRing(rings[0]);
            const ringLocal = rings[0].map((v) => new THREE.Vector3(...rdLocalize(v)));
            const centroid = new THREE.Vector3();
            for (const v of ringLocal) centroid.add(v);
            centroid.divideScalar(ringLocal.length || 1);
            const faceIdx = roofFaces.length;
            roofFaces.push({
              buildingId: coId,
              faceIndex: faceIdx,
              azimuthDeg: azimuth,
              tiltDeg: tilt,
              ringWorld: ringLocal,
              area: ringArea3D(rings[0]),
              centroidLocal: centroid,
              isHighlightDom: null,
            });
            for (const tri of triangles) {
              roofsBuilder.addTriangle(tri[0], tri[1], tri[2]);
              roofTriangleToFace.push(faceIdx);
            }
          } else if (semType === 'GroundSurface') {
            // Skip — onder maaiveld, geen visuele waarde + zou onze grond doorsnijden
            const meanZ = rings[0].reduce((s, v) => s + v[2], 0) / rings[0].length;
            groundSum += meanZ;
            groundCount += 1;
          } else {
            // WallSurface (default)
            for (const tri of triangles) wallsBuilder.addTriangle(tri[0], tri[1], tri[2]);
          }
        });
      });
    }
  }

  const groundLevelNap = groundCount > 0 ? groundSum / groundCount : 0;

  // Shift alle Y's met -groundLevelNap zodat maaiveld op y=0 ligt en alle dak-coords
  // direct in scene-wereld-space zijn (geen extra group.position.y nodig).
  wallsBuilder.applyYShift(-groundLevelNap);
  roofsBuilder.applyYShift(-groundLevelNap);
  for (const face of roofFaces) {
    face.centroidLocal.y -= groundLevelNap;
    for (const v of face.ringWorld) v.y -= groundLevelNap;
  }

  return {
    walls: wallsBuilder.toBufferGeometry(),
    roofs: roofsBuilder.toBufferGeometry(),
    roofFaces,
    roofTriangleToFace,
    groundLevelNap,
    buildingCount: fc.features.length,
  };
}

/** Decode quantized vertices to RD/NAP world coordinates (meters). */
function decodeVertices(qvs: number[][], t: CityJsonTransform): Array<[number, number, number]> {
  return qvs.map((v) => [
    v[0] * t.scale[0] + t.translate[0],
    v[1] * t.scale[1] + t.translate[1],
    v[2] * t.scale[2] + t.translate[2],
  ]);
}

/** Convert RD/NAP point → local three.js coords. */
function rdLocalize(v: [number, number, number]): [number, number, number] {
  return rdToLocal(v[0], v[1], v[2]);
}

/**
 * Triangulate één face (outer + optionele inner rings).
 * Werkt in 3D door eerst te projecteren op het face-vlak via face-normal.
 * Returns: array van driehoeken in lokale scene-coords.
 */
function triangulateFace(
  rings: Array<Array<[number, number, number]>>,
): Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> {
  const outer = rings[0];
  if (outer.length < 3) return [];

  const normal = computeRingNormal(outer);
  if (normal.lengthSq() < 1e-12) return [];

  const tangent = pickTangent(normal);
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();

  const flat: number[] = [];
  const holeStarts: number[] = [];
  const allLocal: THREE.Vector3[] = [];

  let cursor = 0;
  rings.forEach((ring, ringIdx) => {
    if (ringIdx > 0) holeStarts.push(cursor);
    for (const p of ring) {
      const local = new THREE.Vector3(...rdLocalize(p));
      const u = new THREE.Vector3(p[0], p[1], p[2]).dot(tangent);
      const v = new THREE.Vector3(p[0], p[1], p[2]).dot(bitangent);
      flat.push(u, v);
      allLocal.push(local);
      cursor++;
    }
  });

  const idxs = earcut(flat, holeStarts.length > 0 ? holeStarts : undefined);
  const tris: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];
  for (let i = 0; i < idxs.length; i += 3) {
    const a = allLocal[idxs[i]];
    const b = allLocal[idxs[i + 1]];
    const c = allLocal[idxs[i + 2]];
    tris.push([a, b, c]);
  }
  return tris;
}

/** Newell's method voor robuuste polygon-normal in 3D. */
function computeRingNormal(ring: Array<[number, number, number]>): THREE.Vector3 {
  const n = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i];
    const nxt = ring[(i + 1) % ring.length];
    n.x += (c[1] - nxt[1]) * (c[2] + nxt[2]);
    n.y += (c[2] - nxt[2]) * (c[0] + nxt[0]);
    n.z += (c[0] - nxt[0]) * (c[1] + nxt[1]);
  }
  return n.normalize();
}

function pickTangent(normal: THREE.Vector3): THREE.Vector3 {
  const ref = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(ref, normal).normalize();
}

/** BAG-conventie: 0=noord, 90=oost, 180=zuid, 270=west. Uit RD-coords. */
function azimuthFromRing(ring: Array<[number, number, number]>): number {
  const n = computeRingNormal(ring);
  // n is in RD-stelsel: x=oost, y=noord, z=op
  const azim = (Math.atan2(n.x, n.y) * 180) / Math.PI;
  return (azim + 360) % 360;
}

function tiltFromRing(ring: Array<[number, number, number]>): number {
  const n = computeRingNormal(ring);
  const horiz = Math.sqrt(n.x * n.x + n.y * n.y);
  return (Math.atan2(horiz, n.z) * 180) / Math.PI;
}

function ringArea3D(ring: Array<[number, number, number]>): number {
  // Som van cross-products gedeeld door 2
  if (ring.length < 3) return 0;
  const a = new THREE.Vector3();
  for (let i = 1; i < ring.length - 1; i++) {
    const v0 = new THREE.Vector3(...ring[0]);
    const v1 = new THREE.Vector3(...ring[i]);
    const v2 = new THREE.Vector3(...ring[i + 1]);
    a.add(new THREE.Vector3().crossVectors(v1.sub(v0), v2.sub(v0)));
  }
  return a.length() / 2;
}

/** Helper: bouwt een THREE.BufferGeometry door driehoeken op te tellen. */
class GeometryBuilder {
  positions: number[] = [];
  private normals: number[] = [];

  addTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const n = new THREE.Vector3().crossVectors(ab, ac).normalize();
    if (!Number.isFinite(n.x) || n.lengthSq() < 1e-12) return;
    this.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
  }

  /** Pas een uniforme Y-offset toe op alle vertices (wordt voor 1× aangeroepen ná parse). */
  applyYShift(dy: number): void {
    for (let i = 1; i < this.positions.length; i += 3) {
      this.positions[i] += dy;
    }
  }

  toBufferGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    return g;
  }
}
