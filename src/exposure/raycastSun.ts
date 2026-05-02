import * as THREE from 'three';
import { getSun, getDayRange } from '../sun/sunPosition';
import { uurCurveSamples } from './timeWindows';
import type { UurCurvePoint } from '../ui/chartUurcurve';
import type { MaandPoint } from '../ui/chartMaandgrafiek';

/**
 * Voor één punt in de scene: bereken uurcurve over een dag.
 * Snelle CPU-raycast (geen GPU-pas nodig voor 1 punt × ~30 samples).
 */
export function computeUurCurve(
  worldX: number,
  worldY: number,
  worldZ: number,
  shadowCasters: THREE.Object3D,
  date: Date,
  stepMin: number = 30,
): {
  curve: UurCurvePoint[];
  sunHours: number;
  totalHours: number;
  /** Laatste uur waarop er zon op deze plek viel (-1 als helemaal geen zon). */
  lastSunHour: number;
  /** Eerste uur waarop er zon op deze plek viel (-1 als helemaal geen zon). */
  firstSunHour: number;
  /** Zon-uren binnen het 16:00–22:00 venster. */
  avondZonHours: number;
} {
  const samples = uurCurveSamples(date, stepMin);
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3(worldX, worldY, worldZ);
  const sunDir = new THREE.Vector3();
  let sunCount = 0;
  let avondCount = 0;
  let lastSunHour = -1;
  let firstSunHour = -1;
  const curve: UurCurvePoint[] = [];

  const meshes: THREE.Mesh[] = [];
  shadowCasters.traverse((obj) => {
    if (obj instanceof THREE.Mesh) meshes.push(obj);
  });

  for (const d of samples.dates) {
    const hour = d.getHours() + d.getMinutes() / 60;
    const sun = getSun(d);
    let inSun = false;
    if (!sun.belowHorizon) {
      sunDir.copy(sun.direction);
      raycaster.set(origin, sunDir);
      raycaster.far = 500;
      const hits = raycaster.intersectObjects(meshes, false);
      inSun = hits.length === 0;
    }
    if (inSun) {
      sunCount++;
      if (firstSunHour < 0) firstSunHour = hour;
      lastSunHour = hour;
      if (hour >= 16 && hour <= 22) avondCount++;
    }
    curve.push({ hour, inSun });
  }

  return {
    curve,
    sunHours: (sunCount * stepMin) / 60,
    totalHours: (samples.dates.length * stepMin) / 60,
    lastSunHour,
    firstSunHour,
    avondZonHours: (avondCount * stepMin) / 60,
  };
}

/**
 * Maandgrafiek-data: voor één punt, het aantal direct-zon-uren op de 15e van elke maand.
 * Snel: 12 dagen × ~30 raycasts = ~360 raycasts → < 100ms.
 */
export function computeMaandGrafiek(
  worldX: number,
  worldY: number,
  worldZ: number,
  shadowCasters: THREE.Object3D,
  year: number = new Date().getFullYear(),
  stepMin: number = 30,
): MaandPoint[] {
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3(worldX, worldY, worldZ);
  const sunDir = new THREE.Vector3();
  const meshes: THREE.Mesh[] = [];
  shadowCasters.traverse((obj) => {
    if (obj instanceof THREE.Mesh) meshes.push(obj);
  });

  const out: MaandPoint[] = [];
  for (let m = 0; m < 12; m++) {
    const day = new Date(year, m, 15, 12, 0, 0);
    const range = getDayRange(day);
    let sunCount = 0;
    let total = 0;
    for (let t = range.sunrise.getTime(); t <= range.sunset.getTime(); t += stepMin * 60000) {
      const d = new Date(t);
      const sun = getSun(d);
      if (sun.belowHorizon) continue;
      total++;
      sunDir.copy(sun.direction);
      raycaster.set(origin, sunDir);
      raycaster.far = 500;
      if (raycaster.intersectObjects(meshes, false).length === 0) sunCount++;
    }
    out.push({
      month: m,
      sunHours: (sunCount * stepMin) / 60,
      daylightHours: (total * stepMin) / 60,
    });
  }
  return out;
}
