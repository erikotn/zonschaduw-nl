import * as THREE from 'three';
import type { BagResult } from '../geo/bag';

export interface BuildingsLayer {
  group: THREE.Group;
  walls: THREE.Mesh;
  roofs: THREE.Mesh;
  groundLevelNap: number;
  /** Schakel tussen normaal-kleur dak en PV-vertex-kleuren. */
  setPvColorMode(on: boolean): void;
}

export function buildBuildingsLayer(bag: BagResult): BuildingsLayer {
  const wallsMat = new THREE.MeshStandardMaterial({
    color: 0xc0a487,
    roughness: 0.95,
    metalness: 0.0,
  });
  const roofsMat = new THREE.MeshStandardMaterial({
    color: 0x6a4a3a, // default bruin; PV-modus zet color naar wit + vertexColors=true
    roughness: 0.85,
    metalness: 0.0,
    vertexColors: false,
  });

  const walls = new THREE.Mesh(bag.walls, wallsMat);
  walls.castShadow = true;
  walls.receiveShadow = true;
  walls.name = 'bag-walls';

  const roofs = new THREE.Mesh(bag.roofs, roofsMat);
  roofs.castShadow = true;
  roofs.receiveShadow = true;
  roofs.name = 'bag-roofs';

  // BAG-data is al pre-shifted naar wereld-space (maaiveld op y=0), dus geen group-offset nodig.
  const group = new THREE.Group();
  group.add(walls, roofs);
  group.name = 'buildings';

  return {
    group,
    walls,
    roofs,
    groundLevelNap: bag.groundLevelNap,
    setPvColorMode(on) {
      if (on) {
        roofsMat.vertexColors = true;
        roofsMat.color.setHex(0xffffff);
      } else {
        roofsMat.vertexColors = false;
        roofsMat.color.setHex(0x6a4a3a);
      }
      roofsMat.needsUpdate = true;
    },
  };
}
