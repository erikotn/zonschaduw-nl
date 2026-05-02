import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface SceneRoot {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  clock: THREE.Clock;
  start(): void;
  onBeforeRender(cb: (dt: number) => void): void;
}

export function createSceneRoot(host: HTMLElement): SceneRoot {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.1, 2000);
  camera.position.set(60, 50, 60);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 5;
  controls.maxDistance = 400;
  controls.target.set(0, 0, 0);

  const clock = new THREE.Clock();

  window.addEventListener('resize', () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  const beforeRenderCallbacks: Array<(dt: number) => void> = [];

  function loop() {
    const dt = clock.getDelta();
    for (const cb of beforeRenderCallbacks) cb(dt);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  return {
    renderer,
    scene,
    camera,
    controls,
    clock,
    start() {
      requestAnimationFrame(loop);
    },
    onBeforeRender(cb) {
      beforeRenderCallbacks.push(cb);
    },
  };
}
