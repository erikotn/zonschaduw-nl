import * as THREE from 'three';
import { getSun } from '../sun/sunPosition';
import type { TimeSamples } from './timeWindows';

export interface AccumulatorOptions {
  /** Resolutie van het meetvlak in pixels (256 = 256×256 grid). */
  resolution: number;
  /** Wereld-grootte van het meetvlak in meters (langs een zijde). */
  worldSizeM: number;
  /** Hoogte van het meetvlak boven y=0 (in meters). 1.0 voor terras-modus. */
  measureHeight: number;
  /** Scene die schaduw moet werpen (gebouwen). */
  shadowCasters: THREE.Object3D;
  renderer: THREE.WebGLRenderer;
}

/**
 * GPU-multipass accumulator. Per tijdstap:
 *   1. Render schaduwwerpers naar een depth-target (vanuit zonperspectief)
 *   2. Render een full-screen quad over het meetvlak naar de accumulator-target
 *      → fragment-shader vergelijkt depth met depth-map → 0 of 1
 *   3. Additive blend in de accumulator
 *
 * Resultaat: een textuur met per pixel een gewogen som van zon-zichtbaarheid.
 * Door te delen door totalSamples krijg je de fractie zon (0..1).
 */
export class ExposureAccumulator {
  private depthTarget: THREE.WebGLRenderTarget;
  private accumTarget: THREE.WebGLRenderTarget; // sum (additive)
  private lastSunTarget: THREE.WebGLRenderTarget; // max — laatste zon-tijdstip
  private lightCam: THREE.OrthographicCamera;
  private samplerMaterial: THREE.ShaderMaterial; // sum
  private maxMaterial: THREE.ShaderMaterial; // max
  private fsScene: THREE.Scene;
  private fsCam: THREE.OrthographicCamera;
  private fsQuad: THREE.Mesh;
  private samplesAdded = 0;

  constructor(private opts: AccumulatorOptions) {
    const depthRes = 2048;
    this.depthTarget = new THREE.WebGLRenderTarget(depthRes, depthRes, {
      type: THREE.UnsignedByteType,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
    });
    this.depthTarget.depthTexture = new THREE.DepthTexture(
      depthRes,
      depthRes,
      THREE.UnsignedShortType,
    );
    this.depthTarget.depthTexture.format = THREE.DepthFormat;

    // UnsignedByte: per-pixel waarde 0..255. Caller bepaalt contribution-schaling.
    // Voor terras (49 samples): contribution = 1/49 → max 1.0 (=255) bij volle zon.
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    this.accumTarget = new THREE.WebGLRenderTarget(opts.resolution, opts.resolution, rtOpts);
    this.lastSunTarget = new THREE.WebGLRenderTarget(opts.resolution, opts.resolution, rtOpts);

    this.lightCam = new THREE.OrthographicCamera(
      -opts.worldSizeM,
      opts.worldSizeM,
      opts.worldSizeM,
      -opts.worldSizeM,
      1,
      400,
    );

    // Sampler material: leest depth-map, vergelijkt depth, schrijft 0 of 1
    this.samplerMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uDepthMap: { value: this.depthTarget.depthTexture },
        uLightProj: { value: new THREE.Matrix4() },
        uLightView: { value: new THREE.Matrix4() },
        uWorldSize: { value: opts.worldSizeM },
        uMeasureHeight: { value: opts.measureHeight },
        uContribution: { value: 1.0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        uniform float uWorldSize;
        uniform float uMeasureHeight;
        void main() {
          // position = vec3(-1..1, -1..1, 0). We mappen naar wereld:
          vec3 worldPos = vec3(
            position.x * uWorldSize * 0.5,
            uMeasureHeight,
            -position.y * uWorldSize * 0.5  // y van plane → -z in scene (noord = -Z)
          );
          vWorldPos = worldPos;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorldPos;
        uniform sampler2D uDepthMap;
        uniform mat4 uLightProj;
        uniform mat4 uLightView;
        uniform float uContribution;

        void main() {
          vec4 ls = uLightProj * uLightView * vec4(vWorldPos, 1.0);
          ls.xyz /= ls.w;
          // light-space z is in -1..1; depth-map waarden zijn 0..1
          vec2 uv = ls.xy * 0.5 + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            // Buiten depth-frustum: aannemen dat het zon krijgt
            gl_FragColor = vec4(uContribution, 0.0, 0.0, 1.0);
            return;
          }
          float mapDepth = texture2D(uDepthMap, uv).r;
          float currentDepth = ls.z * 0.5 + 0.5;
          float bias = 0.0008;
          float visibility = (currentDepth - bias) > mapDepth ? 0.0 : 1.0;
          gl_FragColor = vec4(visibility * uContribution, 0.0, 0.0, 1.0);
        }
      `,
    });

    // Max-blending material: schrijft tijdfractie ipv 1.0; max-blend bewaart het hoogste tijdstip
    this.maxMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uDepthMap: { value: this.depthTarget.depthTexture },
        uLightProj: { value: new THREE.Matrix4() },
        uLightView: { value: new THREE.Matrix4() },
        uTimeFraction: { value: 0.0 },
      },
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      vertexShader: this.samplerMaterial.vertexShader,
      fragmentShader: /* glsl */ `
        varying vec3 vWorldPos;
        uniform sampler2D uDepthMap;
        uniform mat4 uLightProj;
        uniform mat4 uLightView;
        uniform float uTimeFraction;
        void main() {
          vec4 ls = uLightProj * uLightView * vec4(vWorldPos, 1.0);
          ls.xyz /= ls.w;
          vec2 uv = ls.xy * 0.5 + 0.5;
          float visibility = 1.0;
          if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            float mapDepth = texture2D(uDepthMap, uv).r;
            float currentDepth = ls.z * 0.5 + 0.5;
            float bias = 0.0008;
            visibility = (currentDepth - bias) > mapDepth ? 0.0 : 1.0;
          }
          // Schrijf de tijd-fractie als de pixel zon krijgt; anders 0
          gl_FragColor = vec4(visibility * uTimeFraction, 0.0, 0.0, 1.0);
        }
      `,
    });
    // Vertex-shader uniforms van max-material moeten met dezelfde uniforms gevoed:
    this.maxMaterial.uniforms.uWorldSize = { value: opts.worldSizeM };
    this.maxMaterial.uniforms.uMeasureHeight = { value: opts.measureHeight };

    this.fsScene = new THREE.Scene();
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.samplerMaterial);
    this.fsQuad.frustumCulled = false;
    this.fsScene.add(this.fsQuad);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  reset(): void {
    const r = this.opts.renderer;
    const oldTarget = r.getRenderTarget();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.accumTarget);
    r.clear(true, true, true);
    r.setRenderTarget(this.lastSunTarget);
    r.clear(true, true, true);
    r.setRenderTarget(oldTarget);
    this.samplesAdded = 0;
  }

  /**
   * Voeg één sample toe op de gegeven datum.
   * @param contribution gewicht per pixel als de zon zichtbaar is (typisch 1/N waarbij N = totaal samples)
   * @param timeFraction 0..1 positie binnen het tijdsvenster (voor "laatste zon"-tracking)
   * Returns true als de zon op dat tijdstip boven de horizon stond.
   */
  addSample(date: Date, contribution: number = 1.0, timeFraction: number = 0): boolean {
    const sun = getSun(date);
    if (sun.belowHorizon) return false;

    const r = this.opts.renderer;
    const dist = 200;
    this.lightCam.position.copy(sun.direction).multiplyScalar(dist);
    this.lightCam.lookAt(0, 0, 0);
    this.lightCam.updateMatrixWorld();
    this.lightCam.updateProjectionMatrix();

    // Pass 1: depth render van schaduwwerpers.
    // De DepthTexture op het render-target wordt automatisch gevuld door de WebGL pipeline
    // tijdens een normale render — geen overrideMaterial nodig.
    const oldTarget = r.getRenderTarget();
    const originalParent = this.opts.shadowCasters.parent;
    const tmpScene = this.tmpScene();
    tmpScene.add(this.opts.shadowCasters);

    r.setRenderTarget(this.depthTarget);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    r.render(tmpScene, this.lightCam);

    if (originalParent) {
      originalParent.add(this.opts.shadowCasters);
    } else {
      tmpScene.remove(this.opts.shadowCasters);
    }

    // Pass 2a: additive sum naar accumTarget
    // Pass 2b: max-blend naar lastSunTarget (om "laatste zon-tijdstip" bij te houden)
    // BELANGRIJK: autoClear uit, anders wist three.js het render-target voor elke render-call
    // en gaat de accumulatie verloren.
    this.samplerMaterial.uniforms.uLightProj.value.copy(this.lightCam.projectionMatrix);
    this.samplerMaterial.uniforms.uLightView.value.copy(this.lightCam.matrixWorldInverse);
    this.samplerMaterial.uniforms.uContribution.value = contribution;

    this.maxMaterial.uniforms.uLightProj.value.copy(this.lightCam.projectionMatrix);
    this.maxMaterial.uniforms.uLightView.value.copy(this.lightCam.matrixWorldInverse);
    this.maxMaterial.uniforms.uTimeFraction.value = timeFraction;

    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    // sum
    this.fsQuad.material = this.samplerMaterial;
    r.setRenderTarget(this.accumTarget);
    r.render(this.fsScene, this.fsCam);

    // max
    this.fsQuad.material = this.maxMaterial;
    r.setRenderTarget(this.lastSunTarget);
    r.render(this.fsScene, this.fsCam);

    r.autoClear = prevAutoClear;
    r.setRenderTarget(oldTarget);
    this.samplesAdded += contribution;
    return true;
  }

  /**
   * Voeg alle samples uit een TimeSamples reeks toe.
   * timeFraction wordt automatisch berekend als positie binnen de samples-array (0..1).
   * Returns het aantal samples waarop zon boven de horizon was.
   */
  addAll(samples: TimeSamples, contributionPerSample: number = 1.0): number {
    let added = 0;
    const n = samples.dates.length;
    for (let i = 0; i < n; i++) {
      const tf = n > 1 ? i / (n - 1) : 0;
      if (this.addSample(samples.dates[i], contributionPerSample, tf)) added++;
    }
    return added;
  }

  /** Hoe vaak addSample succesvol een zon-zichtbaar bijgedragen heeft (gewogen som). */
  totalContribution(): number {
    return this.samplesAdded;
  }

  /** De accumulator-textuur: per pixel de som van bijdragen (genormaliseerd 0..1). */
  getTexture(): THREE.Texture {
    return this.accumTarget.texture;
  }

  /** "Laatste zon"-textuur: per pixel de hoogste tijdfractie waarop zon viel (0..1 binnen venster). */
  getLastSunTexture(): THREE.Texture {
    return this.lastSunTarget.texture;
  }

  /** Render-target zelf (voor readRenderTargetPixels). */
  getTextureRT(): THREE.WebGLRenderTarget {
    return this.accumTarget;
  }

  getLastSunRT(): THREE.WebGLRenderTarget {
    return this.lastSunTarget;
  }

  /** Bbox in scene-coords waar het meetvlak ligt. */
  getWorldBounds(): { minX: number; maxX: number; minZ: number; maxZ: number; height: number } {
    const half = this.opts.worldSizeM / 2;
    return {
      minX: -half,
      maxX: half,
      minZ: -half,
      maxZ: half,
      height: this.opts.measureHeight,
    };
  }

  /**
   * Lees waarde uit accumulator-textuur op een (x, z)-positie in scene-coords.
   * Retourneert -1 als buiten bbox; anders de gewogen som [0..1].
   */
  readPixel(worldX: number, worldZ: number): number {
    return this.readFromTarget(this.accumTarget, worldX, worldZ);
  }

  /**
   * Lees laatste-zon-tijdfractie op een (x, z)-positie. Retourneert 0 als de pixel
   * geen zon kreeg, anders de hoogste tijdfractie [0..1] waarop zon viel.
   */
  readLastSunPixel(worldX: number, worldZ: number): number {
    return this.readFromTarget(this.lastSunTarget, worldX, worldZ);
  }

  private readFromTarget(target: THREE.WebGLRenderTarget, worldX: number, worldZ: number): number {
    const half = this.opts.worldSizeM / 2;
    if (worldX < -half || worldX > half || worldZ < -half || worldZ > half) return -1;

    const u = (worldX + half) / this.opts.worldSizeM;
    const v = 1 - (worldZ + half) / this.opts.worldSizeM;
    const px = Math.min(this.opts.resolution - 1, Math.floor(u * this.opts.resolution));
    const py = Math.min(this.opts.resolution - 1, Math.floor(v * this.opts.resolution));

    const buf = new Uint8Array(4);
    try {
      this.opts.renderer.readRenderTargetPixels(target, px, py, 1, 1, buf);
      return buf[0] / 255;
    } catch {
      return -1;
    }
  }

  dispose(): void {
    this.depthTarget.dispose();
    this.accumTarget.dispose();
    this.lastSunTarget.dispose();
    this.samplerMaterial.dispose();
    this.maxMaterial.dispose();
  }

  private _tmpScene: THREE.Scene | null = null;
  private tmpScene(): THREE.Scene {
    if (!this._tmpScene) this._tmpScene = new THREE.Scene();
    return this._tmpScene;
  }
}
