import * as THREE from 'three';

/**
 * Viridis colormap (256 stops). Geknipt uit matplotlib's viridis.
 * Zwart→paars→blauw→groen→geel: perceptueel uniform, kleurenblind-vriendelijk.
 */
const VIRIDIS_STOPS: Array<[number, number, number]> = [
  [0.267, 0.005, 0.329],
  [0.282, 0.094, 0.412],
  [0.278, 0.175, 0.483],
  [0.254, 0.265, 0.530],
  [0.221, 0.339, 0.549],
  [0.190, 0.408, 0.557],
  [0.164, 0.471, 0.558],
  [0.139, 0.534, 0.555],
  [0.121, 0.596, 0.543],
  [0.135, 0.659, 0.518],
  [0.208, 0.718, 0.473],
  [0.327, 0.769, 0.404],
  [0.477, 0.821, 0.318],
  [0.647, 0.858, 0.209],
  [0.825, 0.884, 0.106],
  [0.993, 0.906, 0.144],
];

/**
 * Bouw een 1D-textuur (256 × 1) met de viridis-kleurenmap.
 * Kan in een shader gesampled worden met `texture(lut, vec2(value, 0.5))`.
 */
export function buildViridisLUT(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    const idx = t * (VIRIDIS_STOPS.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, VIRIDIS_STOPS.length - 1);
    const f = idx - i0;
    const c0 = VIRIDIS_STOPS[i0];
    const c1 = VIRIDIS_STOPS[i1];
    data[i * 4 + 0] = Math.round((c0[0] + (c1[0] - c0[0]) * f) * 255);
    data[i * 4 + 1] = Math.round((c0[1] + (c1[1] - c0[1]) * f) * 255);
    data[i * 4 + 2] = Math.round((c0[2] + (c1[2] - c0[2]) * f) * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
