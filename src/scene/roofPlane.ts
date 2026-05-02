import * as THREE from 'three';

/**
 * Een dakvlak heeft een normal (uit BAG-azimuth + tilt) en een centroid in lokale coords.
 * Om er polygons op te kunnen tekenen, hebben we een 2D coord-systeem op het vlak nodig.
 */
export interface RoofFrame {
  /** Normal van het dakvlak (eenheidsvector). */
  normal: THREE.Vector3;
  /** Tangent: één van de twee in-plane assen. */
  tangent: THREE.Vector3;
  /** Bitangent: andere in-plane as (= normal × tangent). */
  bitangent: THREE.Vector3;
  /** Punt op het vlak (ankerpunt voor projectie). */
  origin: THREE.Vector3;
}

/**
 * Bouw een orthonormaal frame voor een dakvlak.
 * azimuthDeg: BAG-conventie (0=N, 90=O, 180=Z, 270=W)
 * tiltDeg: hellingshoek (0 = horizontaal, 90 = verticaal)
 * centroid: lokale scene-coords (origin van het vlak)
 *
 * Lokaal: X=oost, Y=op, Z=zuid+. Voor een schuin vlak met BAG-azimuth a en tilt t:
 *   normal = (sin(a)·sin(t), cos(t), -cos(a)·sin(t))
 * (oost-component, op-component, zuid-component)
 */
export function buildRoofFrame(
  azimuthDeg: number,
  tiltDeg: number,
  centroidLocal: THREE.Vector3,
): RoofFrame {
  const az = (azimuthDeg * Math.PI) / 180;
  const tilt = (tiltDeg * Math.PI) / 180;
  const normal = new THREE.Vector3(
    Math.sin(az) * Math.sin(tilt),
    Math.cos(tilt),
    -Math.cos(az) * Math.sin(tilt),
  ).normalize();

  // Tangent: kies een richting die "horizontaal langs het dak" loopt (= oost-west projectie van noord-zuid)
  // Pak een referentie-vector die niet parallel met normal is
  const ref =
    Math.abs(normal.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();

  return {
    normal,
    tangent,
    bitangent,
    origin: centroidLocal.clone(),
  };
}

/** Project een 3D-punt op het vlak naar (u, v) lokale 2D-coords. */
export function projectToPlane(frame: RoofFrame, p: THREE.Vector3): { u: number; v: number } {
  const rel = new THREE.Vector3().subVectors(p, frame.origin);
  return {
    u: rel.dot(frame.tangent),
    v: rel.dot(frame.bitangent),
  };
}

/** Project een 2D (u, v) terug naar 3D wereld-coord op het vlak. */
export function unprojectFromPlane(frame: RoofFrame, u: number, v: number): THREE.Vector3 {
  return new THREE.Vector3()
    .copy(frame.origin)
    .addScaledVector(frame.tangent, u)
    .addScaledVector(frame.bitangent, v);
}

/** Snap een 3D-punt naar het exacte vlak (verwijdert eventuele afwijkingen door numerieke ruis). */
export function snapToPlane(frame: RoofFrame, p: THREE.Vector3): THREE.Vector3 {
  const { u, v } = projectToPlane(frame, p);
  return unprojectFromPlane(frame, u, v);
}

/** Polygon-area in m² in het lokale 2D-systeem (shoelace). */
export function polygonArea2D(verts: Array<{ u: number; v: number }>): number {
  if (verts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const p1 = verts[i];
    const p2 = verts[(i + 1) % verts.length];
    a += p1.u * p2.v - p2.u * p1.v;
  }
  return Math.abs(a) / 2;
}

/** Geef centroide in lokale 2D. */
export function polygonCentroid2D(
  verts: Array<{ u: number; v: number }>,
): { u: number; v: number } {
  let u = 0,
    v = 0;
  for (const p of verts) {
    u += p.u;
    v += p.v;
  }
  return { u: u / verts.length, v: v / verts.length };
}
