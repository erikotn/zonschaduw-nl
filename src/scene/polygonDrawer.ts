import * as THREE from 'three';

export type Vert = { x: number; z: number };

export interface PolygonDrawer {
  group: THREE.Group;
  startDrawing(): void;
  /** Voeg vertex toe; returns true als de polygon werd gesloten (klik vlakbij eerste vertex). */
  addVertex(x: number, z: number): { added: boolean; closed: boolean };
  /** Update preview-lijn naar muispositie (in DRAWING-mode). */
  setHover(x: number, z: number): void;
  finishDrawing(): boolean;
  cancel(): void;
  reset(): void;
  setPolygon(verts: Vert[]): void;
  getPolygon(): Vert[] | null;
  isDrawing(): boolean;
  /** Roep aan als de polygon klaar/gesloten is. */
  onChange(cb: (polygon: Vert[] | null) => void): void;
}

const VERTEX_COLOR = 0xffd84a;
const EDGE_COLOR = 0xffd84a;
const HOVER_COLOR = 0xffd84a;
const SNAP_RADIUS_M = 1.5;
const Y_OFFSET = 0.18;

/**
 * Simpele polygon-tekenaar:
 *   - DRAWING: klik op kaart → vertices, hover toont rubber-band lijn
 *   - Klik vlakbij eerste vertex (binnen SNAP_RADIUS_M) → polygon sluiten
 *   - COMPLETE: polygon getoond als gesloten LineLoop met markers
 */
export function buildPolygonDrawer(): PolygonDrawer {
  const group = new THREE.Group();
  group.name = 'polygon-drawer';
  group.renderOrder = 3;

  const verts: Vert[] = [];
  let drawing = false;
  let closed = false;
  let hoverPos: Vert | null = null;
  const changeCallbacks: Array<(p: Vert[] | null) => void> = [];

  // Render objects
  const vertexGeom = new THREE.SphereGeometry(0.45, 16, 12);
  const vertexMat = new THREE.MeshBasicMaterial({ color: VERTEX_COLOR });
  const firstVertexMat = new THREE.MeshBasicMaterial({ color: 0xff7a30 });
  const vertexMeshes: THREE.Mesh[] = [];

  const edgeMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.95 });
  const hoverMat = new THREE.LineDashedMaterial({
    color: HOVER_COLOR,
    transparent: true,
    opacity: 0.7,
    dashSize: 0.5,
    gapSize: 0.4,
  });
  let edgeLine: THREE.Line | null = null;
  let hoverLine: THREE.Line | null = null;

  // Snap-target ring (rond eerste vertex tijdens drawing)
  const snapRingGeom = new THREE.RingGeometry(SNAP_RADIUS_M * 0.9, SNAP_RADIUS_M, 32);
  snapRingGeom.rotateX(-Math.PI / 2);
  const snapRingMat = new THREE.MeshBasicMaterial({
    color: 0xff7a30,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const snapRing = new THREE.Mesh(snapRingGeom, snapRingMat);
  snapRing.visible = false;
  group.add(snapRing);

  function rebuildVertexMarkers() {
    // Verwijder oude
    for (const m of vertexMeshes) {
      group.remove(m);
      m.geometry.dispose();
    }
    vertexMeshes.length = 0;
    // Voeg nieuwe toe
    verts.forEach((v, i) => {
      const m = new THREE.Mesh(vertexGeom, i === 0 && drawing && !closed ? firstVertexMat : vertexMat);
      m.position.set(v.x, Y_OFFSET, v.z);
      group.add(m);
      vertexMeshes.push(m);
    });
  }

  function rebuildEdgeLine() {
    if (edgeLine) {
      group.remove(edgeLine);
      edgeLine.geometry.dispose();
      edgeLine = null;
    }
    if (verts.length < 2) return;
    const points = verts.map((v) => new THREE.Vector3(v.x, Y_OFFSET, v.z));
    if (closed) points.push(points[0].clone());
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    edgeLine = new THREE.Line(geom, edgeMat);
    edgeLine.renderOrder = 3;
    group.add(edgeLine);
  }

  function rebuildHoverLine() {
    if (hoverLine) {
      group.remove(hoverLine);
      hoverLine.geometry.dispose();
      hoverLine = null;
    }
    if (!drawing || closed || !hoverPos || verts.length === 0) return;
    const last = verts[verts.length - 1];
    const points = [
      new THREE.Vector3(last.x, Y_OFFSET, last.z),
      new THREE.Vector3(hoverPos.x, Y_OFFSET, hoverPos.z),
    ];
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    hoverLine = new THREE.Line(geom, hoverMat);
    hoverLine.computeLineDistances();
    hoverLine.renderOrder = 3;
    group.add(hoverLine);
  }

  function updateSnapRing() {
    if (drawing && !closed && verts.length >= 3) {
      snapRing.visible = true;
      const first = verts[0];
      snapRing.position.set(first.x, Y_OFFSET, first.z);
    } else {
      snapRing.visible = false;
    }
  }

  function rebuildAll() {
    rebuildVertexMarkers();
    rebuildEdgeLine();
    rebuildHoverLine();
    updateSnapRing();
  }

  function fireChange() {
    const out = closed ? verts.slice() : null;
    for (const cb of changeCallbacks) cb(out);
  }

  return {
    group,
    startDrawing() {
      drawing = true;
      closed = false;
      verts.length = 0;
      hoverPos = null;
      rebuildAll();
      fireChange();
    },
    addVertex(x, z) {
      if (!drawing || closed) return { added: false, closed };
      // Snap to first vertex?
      if (verts.length >= 3) {
        const first = verts[0];
        const dx = first.x - x,
          dz = first.z - z;
        if (Math.sqrt(dx * dx + dz * dz) < SNAP_RADIUS_M) {
          closed = true;
          drawing = false;
          rebuildAll();
          fireChange();
          return { added: false, closed: true };
        }
      }
      verts.push({ x, z });
      rebuildAll();
      return { added: true, closed: false };
    },
    setHover(x, z) {
      if (!drawing || closed) return;
      hoverPos = { x, z };
      rebuildHoverLine();
    },
    finishDrawing() {
      if (!drawing || verts.length < 3) return false;
      closed = true;
      drawing = false;
      rebuildAll();
      fireChange();
      return true;
    },
    cancel() {
      if (drawing) {
        drawing = false;
        verts.length = 0;
        hoverPos = null;
        rebuildAll();
        fireChange();
      }
    },
    reset() {
      drawing = false;
      closed = false;
      verts.length = 0;
      hoverPos = null;
      rebuildAll();
      fireChange();
    },
    setPolygon(newVerts) {
      verts.length = 0;
      verts.push(...newVerts);
      drawing = false;
      closed = newVerts.length >= 3;
      hoverPos = null;
      rebuildAll();
      fireChange();
    },
    getPolygon() {
      return closed ? verts.slice() : null;
    },
    isDrawing() {
      return drawing;
    },
    onChange(cb) {
      changeCallbacks.push(cb);
    },
  };
}
