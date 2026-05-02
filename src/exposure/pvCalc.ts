import * as THREE from 'three';
import { getSun } from '../sun/sunPosition';
import { buildRoofFrame, projectToPlane, unprojectFromPlane } from '../scene/roofPlane';

/**
 * PVGIS-style baseline kWh/m²/jaar voor zonnepanelen op 53°N (Nederland).
 * Bron: geinterpoleerd uit https://re.jrc.ec.europa.eu/pvg_tools/ voor module-vlak,
 * 14% rendement equivalent → omgezet naar kWh per m² panelen-oppervlak per jaar.
 *
 * azimuthFromSouth: 0=zuid, 45=ZW/ZO, 90=W/O, 135=NW/NO, 180=noord
 * tilt: helling van paneel-vlak (0=plat, 90=verticaal)
 */
const PVGIS_53N: number[][] = [
  //  az: 0    45    90    135   180   (kWh/m²/jaar globaal op vlak)
  /* tilt 0  */ [195, 195, 195, 195, 195],
  /* tilt 15 */ [215, 213, 205, 195, 185],
  /* tilt 30 */ [228, 224, 206, 184, 168],
  /* tilt 45 */ [232, 226, 200, 174, 155],
  /* tilt 60 */ [228, 220, 188, 158, 140],
  /* tilt 75 */ [216, 205, 170, 138, 117],
  /* tilt 90 */ [193, 178, 142, 110, 91],
];
const TILT_STOPS = [0, 15, 30, 45, 60, 75, 90];
const AZ_STOPS = [0, 45, 90, 135, 180];

/** Bilineaire interpolatie over (azimuthFromSouth, tilt). Beide in graden. */
export function pvBaselinePerM2(azimuthFromSouth: number, tiltDeg: number): number {
  const a = clamp(azimuthFromSouth, 0, 180);
  const t = clamp(tiltDeg, 0, 90);
  // Vind tilt-rij
  let ti = 0;
  while (ti < TILT_STOPS.length - 2 && t > TILT_STOPS[ti + 1]) ti++;
  const tFrac = (t - TILT_STOPS[ti]) / (TILT_STOPS[ti + 1] - TILT_STOPS[ti]);
  // Vind azimuth-kolom
  let aj = 0;
  while (aj < AZ_STOPS.length - 2 && a > AZ_STOPS[aj + 1]) aj++;
  const aFrac = (a - AZ_STOPS[aj]) / (AZ_STOPS[aj + 1] - AZ_STOPS[aj]);
  // Interpolatie
  const top = lerp(PVGIS_53N[ti][aj], PVGIS_53N[ti][aj + 1], aFrac);
  const bot = lerp(PVGIS_53N[ti + 1][aj], PVGIS_53N[ti + 1][aj + 1], aFrac);
  return lerp(top, bot, tFrac);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Converteer BAG-azimuth (0=N, 90=O, 180=Z, 270=W) → "afwijking van zuid" 0..180. */
export function azimuthFromSouth(bagAzimuth: number): number {
  // bagAz 180 → 0 (zuid). bagAz 90 of 270 → 90. bagAz 0 → 180 (noord).
  let delta = ((bagAzimuth - 180) % 360 + 360) % 360; // 0..360 vanaf zuid
  if (delta > 180) delta = 360 - delta; // 0..180 (oost en west symmetrisch)
  return delta;
}

/** Tekst-label voor windrichting bij een BAG-azimuth. */
export function azimuthLabel(bagAzimuth: number): string {
  const a = ((bagAzimuth % 360) + 360) % 360;
  const dirs = ['N', 'NO', 'O', 'ZO', 'Z', 'ZW', 'W', 'NW'];
  const idx = Math.round(a / 45) % 8;
  return dirs[idx];
}

export interface RoofFaceLight {
  buildingId: string;
  faceIndex: number;
  azimuthDeg: number;
  tiltDeg: number;
  area: number;
  /** Centroïde van de outer ring in lokale scene-coords (X/Z vlak), Y is het hoogste punt. */
  centroidLocal: THREE.Vector3;
  /** Outer ring vertices in lokale scene-coords (voor multi-sample raycast).
   *  Optional: zonder ring valt het terug op single-sample (centroid). */
  ringWorld?: THREE.Vector3[];
}

export interface RoofPVResult {
  faceIndex: number;
  azimuthDeg: number;
  tiltDeg: number;
  area: number;
  azimuthLabel: string;
  /** Baseline op een onbelemmerd dakvlak van die oriëntatie/helling (kWh/m²/jaar). */
  baselinePerM2: number;
  /** Schaduw-fractie 0..1 (1 = volle zon, 0 = altijd schaduw). */
  exposureFraction: number;
  /** Werkelijke opbrengst (kWh/m²/jaar) na schaduw-correctie. */
  actualPerM2: number;
  /** Totale opbrengst voor het hele dakvlak (kWh/jaar). */
  totalKwhPerYear: number;
}

/**
 * Maakt sample-punten op het dakvlak voor multi-point raycasting.
 * 3×3 raster binnen de bbox van het outer ring, gefilterd op punten BINNEN de polygon
 * zodat irreguliere dakvormen correct worden gesampled.
 *
 * Returns minimaal het centroid-punt als fallback.
 */
function buildFaceSamples(face: RoofFaceLight, gridSize: number = 3): THREE.Vector3[] {
  if (!face.ringWorld || face.ringWorld.length < 3) {
    return [face.centroidLocal.clone()];
  }
  const frame = buildRoofFrame(face.azimuthDeg, face.tiltDeg, face.centroidLocal);
  // Project ring naar 2D uv
  const verts2d = face.ringWorld.map((p) => projectToPlane(frame, p));
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (const p of verts2d) {
    if (p.u < minU) minU = p.u;
    if (p.u > maxU) maxU = p.u;
    if (p.v < minV) minV = p.v;
    if (p.v > maxV) maxV = p.v;
  }

  const samples: THREE.Vector3[] = [];
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const u = minU + ((i + 0.5) / gridSize) * (maxU - minU);
      const v = minV + ((j + 0.5) / gridSize) * (maxV - minV);
      if (pointInPolygon2D(verts2d, u, v)) {
        samples.push(unprojectFromPlane(frame, u, v));
      }
    }
  }
  if (samples.length === 0) samples.push(face.centroidLocal.clone());
  return samples;
}

function pointInPolygon2D(
  ring: Array<{ u: number; v: number }>,
  u: number,
  v: number,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ui = ring[i].u,
      vi = ring[i].v;
    const uj = ring[j].u,
      vj = ring[j].v;
    const intersect = vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Bereken per dakvlak de PV-opbrengst.
 *
 * Schaduw-fractie wordt gemeten via multi-sample raycasting: voor elk dakvlak
 * een 3×3 raster van sample-punten binnen de polygon (~9 punten), per tijdstip
 * een ray naar de zon — fractie = (visible samples) / (total samples × time samples).
 *
 * Voor 12 maanden × 35 uur-stappen × 9 sample-punten × 71 vlakken ≈ 270k raycasts.
 *
 * NB: wij meten alleen de DIRECTE zon-fractie. Diffuus licht draagt ~50-60% bij
 * aan de jaaropbrengst en is bijna isotroop. We benaderen door te schalen tussen
 * baseline (volle zon) en 50% baseline (volle schaduw) — d.w.z. zelfs een totaal
 * geschaduwd vlak krijgt nog ~50% via diffuus.
 */
export function computeRoofPV(
  faces: RoofFaceLight[],
  shadowCasters: THREE.Object3D,
  year: number = new Date().getFullYear(),
): RoofPVResult[] {
  const meshes: THREE.Mesh[] = [];
  shadowCasters.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });

  // Tijdstippen: 12 maanden × elk uur op de 21e (multi-sample is duur, daarom 1h ipv 0.5h)
  const sunSamples: { dir: THREE.Vector3 }[] = [];
  for (let m = 0; m < 12; m++) {
    for (let h = 5; h <= 22; h += 1) {
      const date = new Date(year, m, 21, h, 0, 0);
      const sun = getSun(date);
      if (sun.belowHorizon) continue;
      sunSamples.push({ dir: sun.direction });
    }
  }

  const out: RoofPVResult[] = [];
  const raycaster = new THREE.Raycaster();
  raycaster.far = 500;
  const origin = new THREE.Vector3();

  for (const f of faces) {
    // Normal vector voor dit dakvlak in lokale coords (X=oost, Y=op, Z=zuid+)
    const azRad = (f.azimuthDeg * Math.PI) / 180;
    const tiltRad = (f.tiltDeg * Math.PI) / 180;
    const normal = new THREE.Vector3(
      Math.sin(azRad) * Math.sin(tiltRad),
      Math.cos(tiltRad),
      -Math.cos(azRad) * Math.sin(tiltRad),
    ).normalize();

    // Bouw sample-grid op het dakvlak (3×3 binnen polygon, of fallback centroid)
    const samples = buildFaceSamples(f, 3);

    // Per zon-richting: tel het aantal sample-punten dat zon ziet, deel door totaal
    let totalAbove = 0;
    let cumulativeVisibleFraction = 0;

    for (const s of sunSamples) {
      const cosAngle = normal.dot(s.dir);
      if (cosAngle <= 0) continue; // zon staat achter het paneel-vlak
      totalAbove++;

      let visibleSamples = 0;
      for (const samplePoint of samples) {
        origin.copy(samplePoint).addScaledVector(normal, 0.05); // anti-self-shadow bias
        raycaster.set(origin, s.dir);
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length === 0) visibleSamples++;
      }
      cumulativeVisibleFraction += visibleSamples / samples.length;
    }

    const directVisible = totalAbove > 0 ? cumulativeVisibleFraction / totalAbove : 0;
    // Combined direct + diffuus model: full baseline bij geen schaduw, halve bij volle schaduw
    const exposureFraction = 0.5 + 0.5 * directVisible;

    const azFromS = azimuthFromSouth(f.azimuthDeg);
    const baseline = pvBaselinePerM2(azFromS, f.tiltDeg);
    const actual = baseline * exposureFraction;
    out.push({
      faceIndex: f.faceIndex,
      azimuthDeg: f.azimuthDeg,
      tiltDeg: f.tiltDeg,
      area: f.area,
      azimuthLabel: azimuthLabel(f.azimuthDeg),
      baselinePerM2: baseline,
      exposureFraction: directVisible, // pure direct, gemiddeld over sample-grid
      actualPerM2: actual,
      totalKwhPerYear: actual * f.area,
    });
  }

  return out;
}
