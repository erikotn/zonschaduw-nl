import * as THREE from 'three';

export interface GroundLayer {
  mesh: THREE.Mesh;
  setAerialVisible(visible: boolean): void;
  /** Vervang de achtergrond-textuur door een nieuwe (voor wisselen luchtfoto/topo). */
  setBackgroundTexture(tex: THREE.Texture | null): void;
  /** Verschuif de achtergrond ten opzichte van de wereld-coords (uitlijning). */
  setOffset(dx: number, dz: number): void;
}

/**
 * Grondvlak. Centroide ligt op (0, 0, 0). Ontvangt schaduw.
 * Ontvangt een luchtfoto-texture die exact op de bbox past.
 */
export function buildGroundLayer(aerialTexture: THREE.Texture | null, sizeM: number): GroundLayer {
  const geom = new THREE.PlaneGeometry(sizeM, sizeM, 1, 1);
  // PlaneGeometry default ligt in het xy-vlak, met UVs (0,0)→(1,1) van linksboven naar rechtsonder.
  // Na rotatie -π/2 om x-as: x→x (oost), y(plane)→z (zuid).
  // De luchtfoto is in RD: x=oost, y=noord. WMS-default: pixel (0,0) is linksboven = (minX, maxY).
  // Plane vertex (-W/2, +H/2) → na rotatie (-W/2, 0, -H/2). UV (0,1) hoort op het verste-noord-westen-vertex.
  // Default plane UV: (0,0)=(-W/2,-H/2,vertex), (1,1)=(+W/2,+H/2,vertex). Na rotatie wordt dat
  // (0,0)→(-W/2,0,+H/2)=zuidwest, (1,1)→(+W/2,0,-H/2)=noordoost. Dat klopt met luchtfoto:
  // pixel (0, height-1)=zuidwest, pixel (width-1, 0)=noordoost. ✔︎ (default UV doet wat we willen)

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    map: aerialTexture ?? null,
  });
  if (!aerialTexture) material.color = new THREE.Color(0x4a5a4a);

  const mesh = new THREE.Mesh(geom, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'ground';

  let currentTex = aerialTexture;
  let aerialVisible = true;

  return {
    mesh,
    setAerialVisible(visible) {
      aerialVisible = visible;
      if (currentTex) {
        material.map = visible ? currentTex : null;
        material.color.set(visible ? 0xffffff : 0x4a5a4a);
        material.needsUpdate = true;
      }
    },
    setBackgroundTexture(tex) {
      currentTex = tex;
      if (aerialVisible && tex) {
        material.map = tex;
        material.color.set(0xffffff);
      } else {
        material.map = null;
        material.color.set(0x4a5a4a);
      }
      material.needsUpdate = true;
    },
    setOffset(dx, dz) {
      mesh.position.set(dx, mesh.position.y, dz);
    },
  };
}
