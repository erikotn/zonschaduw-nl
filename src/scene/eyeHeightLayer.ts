import * as THREE from 'three';

export interface EyeHeightLayerOpts {
  worldSizeM: number;
  measureHeight: number;
  exposureTexture: THREE.Texture;
  colormapLUT: THREE.Texture;
  /** Aantal samples in de accumulator (om te normaliseren naar 0..1). */
  totalSamples: number;
  /** Aantal minuten per sample (om uren-equivalent te tonen). */
  intervalMinutes: number;
}

export interface EyeHeightLayer {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  setVisible(visible: boolean): void;
  setOpacity(opacity: number): void;
  /** Update als nieuwe accumulator-data binnenkomt. */
  setExposure(texture: THREE.Texture, totalSamples: number, intervalMinutes: number): void;
  /** Wissel actieve textuur (bv. tussen "totaal" en "laatste zon"). */
  setActiveTexture(texture: THREE.Texture): void;
}

/**
 * Vlak op meet-hoogte (1m) dat de exposure-textuur kleurt via colormap.
 * Half-transparant zodat je de luchtfoto eronder ziet.
 */
export function buildEyeHeightLayer(opts: EyeHeightLayerOpts): EyeHeightLayer {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uExposure: { value: opts.exposureTexture },
      uColormap: { value: opts.colormapLUT },
      uTotalSamples: { value: opts.totalSamples },
      uIntervalMin: { value: opts.intervalMinutes },
      uOpacity: { value: 0.75 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uExposure;
      uniform sampler2D uColormap;
      uniform float uOpacity;
      varying vec2 vUv;

      void main() {
        // accumulator-waarde is genormaliseerd 0..1 (caller geeft contribution = 1/N door)
        float frac = clamp(texture2D(uExposure, vUv).r, 0.0, 1.0);
        vec3 color = texture2D(uColormap, vec2(frac, 0.5)).rgb;
        gl_FragColor = vec4(color, uOpacity);
      }
    `,
  });

  const geom = new THREE.PlaneGeometry(opts.worldSizeM, opts.worldSizeM, 1, 1);
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  // Material aan beide zijden zichtbaar, en op grond-niveau geprojecteerd zodat het altijd
  // bovenop de luchtfoto ligt en je 'm makkelijk kan lezen vanuit elke camera-hoek.
  // De METING gebeurt nog steeds op measureHeight (zit-hoogte 1m), maar de display ligt op de grond.
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geom, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.08; // net boven grondvlak (z-fighting voorkomen)
  mesh.renderOrder = 1; // boven het grondvlak renderen
  mesh.frustumCulled = false; // anders kan grote tilted plane wegvallen
  mesh.name = 'eye-height-layer';
  mesh.visible = false;

  return {
    mesh,
    material,
    setVisible(v) {
      mesh.visible = v;
    },
    setOpacity(o) {
      material.uniforms.uOpacity.value = o;
    },
    setExposure(tex, total, intervalMin) {
      material.uniforms.uExposure.value = tex;
      material.uniforms.uTotalSamples.value = total;
      material.uniforms.uIntervalMin.value = intervalMin;
    },
    setActiveTexture(tex) {
      material.uniforms.uExposure.value = tex;
    },
  };
}
