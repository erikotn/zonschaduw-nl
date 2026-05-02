import * as THREE from 'three';
import type { Parcel } from '../geo/parcel';

export interface ParcelOutlineLayer {
  group: THREE.Group;
  setSelected(ids: Set<string>): void;
  /** Returns het Parcel.id dat een ray hits, of null. */
  pickAt(raycaster: THREE.Raycaster): string | null;
  setPickingEnabled(on: boolean): void;
}

const SELECTED_COLOR = 0xffd84a; // goudgeel
const UNSELECTED_COLOR = 0x6a7080; // koel grijsblauw
const HOVER_HEIGHT = 0.12; // net boven grond

/**
 * Eén THREE.Group met per perceel:
 *   - LineLoop voor de outline (geselecteerd = goud, anders grijs)
 *   - Een onzichtbare "pick"-mesh (vlakke polygon) voor klik-detectie
 */
export function buildParcelOutlineLayer(parcels: Parcel[]): ParcelOutlineLayer {
  const group = new THREE.Group();
  group.name = 'parcel-outlines';

  type Entry = {
    parcel: Parcel;
    line: THREE.LineLoop;
    pickMesh: THREE.Mesh;
  };
  const entries: Entry[] = [];
  let selected = new Set<string>();
  let pickingEnabled = false;

  for (const p of parcels) {
    const outer = p.rings[0];
    const points = outer.map((c) => new THREE.Vector3(c.x, HOVER_HEIGHT, c.z));
    const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
      color: UNSELECTED_COLOR,
      linewidth: 2, // wordt door driver vaak genegeerd, maar OK
      transparent: true,
      opacity: 0.85,
    });
    const line = new THREE.LineLoop(lineGeom, lineMat);
    line.renderOrder = 2;
    line.name = `parcel-line-${p.id}`;

    // Pick-mesh: een ShapeGeometry van de outer ring, plat op grond, onzichtbaar maar raycastbaar
    const shape = new THREE.Shape(outer.map((c) => new THREE.Vector2(c.x, c.z)));
    const shapeGeom = new THREE.ShapeGeometry(shape);
    // ShapeGeometry produces XY plane; rotate so it lies on XZ.
    shapeGeom.rotateX(-Math.PI / 2);
    // Y-shift naar HOVER_HEIGHT zodat de raycaster 'm op de grond raakt
    shapeGeom.translate(0, HOVER_HEIGHT - 0.01, 0);
    const pickMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
    const pickMesh = new THREE.Mesh(shapeGeom, pickMat);
    pickMesh.userData.parcelId = p.id;
    pickMesh.name = `parcel-pick-${p.id}`;

    group.add(line, pickMesh);
    entries.push({ parcel: p, line, pickMesh });
  }

  function applySelection() {
    for (const e of entries) {
      const isSel = selected.has(e.parcel.id);
      const mat = e.line.material as THREE.LineBasicMaterial;
      mat.color.setHex(isSel ? SELECTED_COLOR : UNSELECTED_COLOR);
      mat.opacity = isSel ? 1.0 : pickingEnabled ? 0.6 : 0.0;
      e.line.visible = isSel || pickingEnabled;
      e.pickMesh.visible = pickingEnabled; // alleen klikbaar als 'edit' aan
    }
  }

  applySelection();

  return {
    group,
    setSelected(ids) {
      selected = new Set(ids);
      applySelection();
    },
    pickAt(raycaster) {
      const meshes = entries.filter((e) => e.pickMesh.visible).map((e) => e.pickMesh);
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return null;
      return (hits[0].object.userData.parcelId as string) ?? null;
    },
    setPickingEnabled(on) {
      pickingEnabled = on;
      applySelection();
    },
  };
}
