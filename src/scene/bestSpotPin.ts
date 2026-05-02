import * as THREE from 'three';

export interface BestSpotPin {
  group: THREE.Group;
  setPosition(x: number, z: number): void;
  setVisible(v: boolean): void;
}

export function buildBestSpotPin(): BestSpotPin {
  const group = new THREE.Group();
  group.name = 'best-spot-pin';

  // Goudgele kegel (omgekeerd, punt naar onder, op 4m hoogte)
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.6, 2.5, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.95 }),
  );
  cone.rotation.x = Math.PI;
  cone.position.y = 4.5;

  // Stipje op grond
  const ringGeo = new THREE.RingGeometry(0.5, 0.7, 32);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  ring.position.y = 0.13;

  // Lijn omhoog
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.15, 0),
    new THREE.Vector3(0, 3.2, 0),
  ]);
  const line = new THREE.Line(
    lineGeom,
    new THREE.LineBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.6 }),
  );

  group.add(cone, ring, line);
  group.visible = false;
  return {
    group,
    setPosition(x, z) {
      group.position.set(x, 0, z);
    },
    setVisible(v) {
      group.visible = v;
    },
  };
}
