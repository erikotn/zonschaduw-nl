import * as THREE from 'three';
import type { RoofPVResult } from '../exposure/pvCalc';

/**
 * Kleur voor PV-opbrengst (kWh/m²/jaar):
 *   < 90    → rood (slechte plek)
 *   90-130  → oranje
 *   130-170 → geel
 *   > 170   → groen
 *
 * Lineair geinterpoleerd voor een vloeiende gradient.
 */
function pvColor(actualPerM2: number): THREE.Color {
  // Stops in kWh/m²/jaar
  const stops: Array<[number, [number, number, number]]> = [
    [60, [0.65, 0.12, 0.08]], // diep rood
    [100, [0.95, 0.32, 0.12]], // rood-oranje
    [140, [0.95, 0.66, 0.12]], // geel
    [180, [0.4, 0.78, 0.18]], // licht groen
    [220, [0.18, 0.62, 0.32]], // diep groen
  ];
  const v = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], actualPerM2));
  let i = 0;
  while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
  const t = (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
  const a = stops[i][1];
  const b = stops[i + 1][1];
  return new THREE.Color(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** Donkere grijze kleur voor dakvlakken die zijn uitgesloten (riet/anders). */
const EXCLUDED_COLOR = new THREE.Color(0x3a3a3a);

/**
 * Zet vertex-colors op de roofs-geometrie zodat elk dakvlak een kleur krijgt
 * gebaseerd op de PV-opbrengst. Uitgesloten dakvlakken krijgen een donkergrijze tint.
 *
 * `triangleToFace` is een array van face-indices, één per driehoek (3 vertices)
 * in de positions-buffer.
 */
export function applyPvColors(
  roofsGeom: THREE.BufferGeometry,
  triangleToFace: number[],
  results: RoofPVResult[],
  excludedFaces?: Set<number>,
): void {
  const positionAttr = roofsGeom.getAttribute('position') as THREE.BufferAttribute;
  const vertexCount = positionAttr.count;
  const colors = new Float32Array(vertexCount * 3);

  const faceColors = new Map<number, THREE.Color>();
  for (const r of results) faceColors.set(r.faceIndex, pvColor(r.actualPerM2));

  for (let triIdx = 0; triIdx < triangleToFace.length; triIdx++) {
    const faceIdx = triangleToFace[triIdx];
    const isExcluded = excludedFaces?.has(faceIdx) ?? false;
    const c = isExcluded
      ? EXCLUDED_COLOR
      : faceColors.get(faceIdx) ?? new THREE.Color(0x808080);
    for (let vi = 0; vi < 3; vi++) {
      const v = triIdx * 3 + vi;
      colors[v * 3 + 0] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
  }
  roofsGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Reset (verwijder) PV-kleuring zodat het oorspronkelijke material weer gewone kleur toont. */
export function clearPvColors(roofsGeom: THREE.BufferGeometry): void {
  if (roofsGeom.getAttribute('color')) roofsGeom.deleteAttribute('color');
}
