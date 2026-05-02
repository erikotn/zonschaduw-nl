import * as THREE from 'three';
import type { ExposureAccumulator } from './accumulator';

export interface BestSpot {
  worldX: number;
  worldZ: number;
  /** Genormaliseerde waarde 0..1 van de gekozen textuur op deze plek. */
  value: number;
}

export type BestSpotMode = 'totaal' | 'laatste';

/** Eén polygoon (outer ring) in lokale scene-coords. */
export type SearchPolygon = Array<{ x: number; z: number }>;

/**
 * Scan alle pixels in de accumulator-textuur en vind het pixel binnen de unie
 * van de polygons met de hoogste waarde.
 *
 * Voor 'totaal': max van de sum-textuur (= meeste zonuren binnen venster)
 * Voor 'laatste': max van de last-sun-textuur (= zon valt het langst door)
 */
export function findBestSpot(
  accumulator: ExposureAccumulator,
  polygons: SearchPolygon[],
  mode: BestSpotMode,
  worldSizeM: number,
  resolution: number,
  renderer: THREE.WebGLRenderer,
): BestSpot | null {
  if (polygons.length === 0) return null;

  // Lees de hele textuur uit
  const target = mode === 'totaal' ? accumulator.getTextureRT() : accumulator.getLastSunRT();
  const buf = new Uint8Array(resolution * resolution * 4);
  try {
    renderer.readRenderTargetPixels(target, 0, 0, resolution, resolution, buf);
  } catch {
    return null;
  }

  const half = worldSizeM / 2;
  let bestVal = -1;
  let bestPx = -1;
  let bestPy = -1;

  for (let py = 0; py < resolution; py++) {
    // pixel-y → world-z: v = 1 - py/res, world-z = (1 - v) * worldSize - half = (py/res) * worldSize - half
    // Wacht: in onze read uit accum-target is de origin links-onder (WebGL native).
    // De display-shader leest textuur met UV waar v=0 zuid en v=1 noord.
    // In readRenderTargetPixels gebruikt three.js framebuffer-coords: y=0 is onder.
    // De accumulator schrijft via fs-quad zodat positie.y +1 → worldPos.z = -worldSize/2 (noord).
    // Dus pixel py=0 (onderste rij) → noord. Mapping: worldZ = -half + (1 - py/(res-1)) * worldSize... laat me 't conservatief uittesten met de juiste formule.
    // Simpelste check: positie.y van plane-vertex op 1 → worldPos.z = -worldSize/2 (noord). Plane-vertex met position.y=1 zit aan de TOP van de plane. In een standaard render gaat top → framebuffer-pixel met hoge y. Dus pixel-py=resolution-1 ≈ noord, py=0 ≈ zuid. → worldZ = (py/(res-1)) * worldSize - half? Nee: noord = -worldSize/2 betekent zuid = +worldSize/2 (Z-positief). Dus py=0 (zuid) → worldZ = +half. py=res-1 (noord) → worldZ = -half. Dus: worldZ = half - py/(res-1) * worldSize.
    const worldZ = half - (py / (resolution - 1)) * worldSizeM;
    for (let px = 0; px < resolution; px++) {
      const worldX = -half + (px / (resolution - 1)) * worldSizeM;
      let inAny = false;
      for (const poly of polygons) {
        if (pointInPolygonXZ(poly, worldX, worldZ)) {
          inAny = true;
          break;
        }
      }
      if (!inAny) continue;
      const idx = (py * resolution + px) * 4;
      const val = buf[idx];
      if (val > bestVal) {
        bestVal = val;
        bestPx = px;
        bestPy = py;
      }
    }
  }

  if (bestVal < 0) return null;

  const worldX = -half + (bestPx / (resolution - 1)) * worldSizeM;
  const worldZ = half - (bestPy / (resolution - 1)) * worldSizeM;
  // Zoek lokaal in een 3×3 buurt voor sub-pixel-betere locatie? Niet nodig voor MVP.
  // Compute centroid van pixels binnen ε van max-waarde voor stabielere positie:
  const eps = Math.max(1, Math.round(0.02 * 255)); // 2% tolerance
  let sx = 0,
    sz = 0,
    n = 0;
  for (let py = 0; py < resolution; py++) {
    const z = half - (py / (resolution - 1)) * worldSizeM;
    for (let px = 0; px < resolution; px++) {
      const x = -half + (px / (resolution - 1)) * worldSizeM;
      let inAny = false;
      for (const poly of polygons) {
        if (pointInPolygonXZ(poly, x, z)) {
          inAny = true;
          break;
        }
      }
      if (!inAny) continue;
      const v = buf[(py * resolution + px) * 4];
      if (v >= bestVal - eps) {
        sx += x;
        sz += z;
        n++;
      }
    }
  }
  const cx = n > 0 ? sx / n : worldX;
  const cz = n > 0 ? sz / n : worldZ;

  return { worldX: cx, worldZ: cz, value: bestVal / 255 };
}

function pointInPolygonXZ(ring: SearchPolygon, x: number, z: number): boolean {
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
