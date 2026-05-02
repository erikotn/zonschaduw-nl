import * as THREE from 'three';
import { SCENE } from '../config';
import { getSun, type SunSample } from '../sun/sunPosition';

export interface SunLight {
  group: THREE.Group;
  directional: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  setDate(date: Date): SunSample;
  current(): SunSample;
}

/**
 * Bouwt zon + ambient + shadow-camera. Zon-richting kan via setDate() bijgewerkt
 * worden; shadow-camera blijft op het huiscentrum gericht.
 */
export function buildSunLight(initial: Date): SunLight {
  const ambient = new THREE.AmbientLight(0xa0c0e0, 0.45);

  const directional = new THREE.DirectionalLight(0xfff2d4, 1.6);
  directional.castShadow = true;
  directional.shadow.mapSize.set(SCENE.shadowMapSize, SCENE.shadowMapSize);
  const f = SCENE.shadowFrustumM;
  directional.shadow.camera.left = -f;
  directional.shadow.camera.right = f;
  directional.shadow.camera.top = f;
  directional.shadow.camera.bottom = -f;
  directional.shadow.camera.near = 1;
  directional.shadow.camera.far = f * 4;
  directional.shadow.bias = -0.0005;
  directional.shadow.normalBias = 0.04;

  // Target is een vast object op de oorsprong.
  const target = new THREE.Object3D();
  target.position.set(0, 0, 0);

  const group = new THREE.Group();
  group.name = 'sun';
  group.add(directional, directional.target ?? target, ambient);
  directional.target = target;
  group.add(target);

  let currentSample: SunSample = getSun(initial);
  applySample(currentSample);

  function applySample(s: SunSample) {
    if (s.belowHorizon) {
      directional.intensity = 0;
      ambient.intensity = 0.1;
    } else {
      // Realistische scaling op zon-altitude (low sun = dimmer)
      const altRad = (s.altitudeDeg * Math.PI) / 180;
      directional.intensity = 0.4 + 1.4 * Math.max(0, Math.sin(altRad));
      ambient.intensity = 0.25 + 0.25 * Math.max(0, Math.sin(altRad));
    }
    // Plaats de zon op een afstand zodat shadow-camera dekt
    const dist = SCENE.shadowFrustumM * 1.5;
    directional.position.copy(s.direction).multiplyScalar(dist);
  }

  return {
    group,
    directional,
    ambient,
    setDate(date) {
      currentSample = getSun(date);
      applySample(currentSample);
      return currentSample;
    },
    current() {
      return currentSample;
    },
  };
}
