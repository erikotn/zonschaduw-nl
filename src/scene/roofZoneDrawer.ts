import * as THREE from 'three';
import { polygonArea2D, projectToPlane, type RoofFrame } from './roofPlane';

export type RoofZone = {
  /** Vertices in 3D wereld-coords, op het dakvlak (snapped). */
  verts: Array<{ x: number; y: number; z: number }>;
};

export interface ActiveDrawingState {
  faceIndex: number;
  inProgress: Array<{ x: number; y: number; z: number }>;
  ringWorld: Array<{ x: number; y: number; z: number }>;
}

export interface RoofZoneDrawer {
  group: THREE.Group;
  /** Start tekenen voor een specifiek dakvlak. ringWorld = outer ring boundary van dat vlak (in lokale scene-coords) voor visuele highlight. */
  startDrawing(
    faceIndex: number,
    frame: RoofFrame,
    ringWorld: Array<{ x: number; y: number; z: number }>,
  ): void;
  /** Voeg vertex toe in 3D (uit raycast op dakvlak). Retourneert {added,closed}. */
  addVertex(p: THREE.Vector3): { added: boolean; closed: boolean };
  /** Update preview-lijn naar muispositie. */
  setHover(p: THREE.Vector3): void;
  finishDrawing(): boolean;
  cancel(): void;
  isDrawing(): boolean;
  activeFaceIndex(): number | null;
  /** Verwijder de laatst getekende zone op een face. */
  popZone(faceIndex: number): boolean;
  /** Verwijder alle zones op een face. */
  clearFace(faceIndex: number): void;
  /** Vervang opgeslagen zones (bv. uit localStorage). */
  setZones(zones: Map<number, RoofZone[]>, frames: Map<number, RoofFrame>): void;
  /** Lees alle zones. */
  getZones(): Map<number, RoofZone[]>;
  /** Zone-area in m² (gesommeerd) per face. */
  getEffectiveAreaForFace(faceIndex: number): number;
  onChange(cb: () => void): void;
}

const VERTEX_COLOR = 0xffd84a;
const FIRST_VERTEX_COLOR = 0xff7a30;
const EDGE_COLOR = 0xffd84a;
const SNAP_RADIUS_M = 1.0;
const Y_LIFT = 0.05; // klein offset boven het dakvlak om z-fighting te voorkomen

/**
 * Polygon-tekenaar speciaal voor dakvlakken: vertices liggen in 3D op het schuine vlak,
 * niet op het grondvlak. Per dakvlak kun je meerdere zones tekenen.
 */
export function buildRoofZoneDrawer(): RoofZoneDrawer {
  const group = new THREE.Group();
  group.name = 'roof-zone-drawer';
  group.renderOrder = 4;

  const zones = new Map<number, RoofZone[]>();
  const frames = new Map<number, RoofFrame>();
  let active: ActiveDrawingState | null = null;
  let hoverPos: THREE.Vector3 | null = null;
  const callbacks: Array<() => void> = [];

  // Render-elementen worden bij elke change opnieuw gebouwd
  const vertexGeom = new THREE.SphereGeometry(0.35, 14, 10);
  const vertexMat = new THREE.MeshBasicMaterial({ color: VERTEX_COLOR });
  const firstVertexMat = new THREE.MeshBasicMaterial({ color: FIRST_VERTEX_COLOR });
  const edgeMat = new THREE.LineBasicMaterial({
    color: EDGE_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });
  const hoverMat = new THREE.LineDashedMaterial({
    color: EDGE_COLOR,
    transparent: true,
    opacity: 0.7,
    dashSize: 0.4,
    gapSize: 0.3,
    depthTest: false,
  });
  const filledMat = new THREE.LineBasicMaterial({
    color: EDGE_COLOR,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  });

  function liftAlongNormal(p: { x: number; y: number; z: number }, frame: RoofFrame | undefined) {
    if (!frame) return new THREE.Vector3(p.x, p.y, p.z);
    return new THREE.Vector3(p.x, p.y, p.z).addScaledVector(frame.normal, Y_LIFT);
  }

  function rebuild() {
    // Verwijder oude
    while (group.children.length) {
      const c = group.children[0];
      if (c instanceof THREE.Mesh) c.geometry.dispose();
      else if (c instanceof THREE.Line) c.geometry.dispose();
      group.remove(c);
    }

    // Render alle voltooide zones
    for (const [fIdx, faceZones] of zones) {
      const frame = frames.get(fIdx);
      for (const z of faceZones) {
        if (z.verts.length < 3) continue;
        const points = z.verts.map((v) => liftAlongNormal(v, frame));
        points.push(points[0].clone());
        const geom = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geom, filledMat);
        line.renderOrder = 4;
        line.frustumCulled = false;
        group.add(line);
      }
    }

    // Render in-progress drawing
    if (active) {
      const frame = frames.get(active.faceIndex);

      // Active-face outline: dikke gele lijn rond het dakvlak zodat je weet waar te klikken
      if (active.ringWorld.length >= 3) {
        const outlinePts = active.ringWorld.map((v) => liftAlongNormal(v, frame));
        outlinePts.push(outlinePts[0].clone());
        const outlineGeom = new THREE.BufferGeometry().setFromPoints(outlinePts);
        const outlineMat = new THREE.LineBasicMaterial({
          color: 0xff7a30,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
        });
        const outlineLine = new THREE.Line(outlineGeom, outlineMat);
        outlineLine.renderOrder = 5;
        outlineLine.frustumCulled = false;
        group.add(outlineLine);
      }

      const lifted = active.inProgress.map((v) => liftAlongNormal(v, frame));
      // Vertex-markers
      lifted.forEach((p, i) => {
        const m = new THREE.Mesh(vertexGeom, i === 0 ? firstVertexMat : vertexMat);
        m.position.copy(p);
        group.add(m);
      });
      // Edge-line
      if (lifted.length >= 2) {
        const geom = new THREE.BufferGeometry().setFromPoints(lifted);
        const line = new THREE.Line(geom, edgeMat);
        line.renderOrder = 4;
        line.frustumCulled = false;
        group.add(line);
      }
      // Hover-line van laatste vertex naar hover-pos
      if (hoverPos && lifted.length > 0) {
        const last = lifted[lifted.length - 1];
        const hoverLifted = liftAlongNormal(hoverPos, frame);
        const geom = new THREE.BufferGeometry().setFromPoints([last, hoverLifted]);
        const line = new THREE.Line(geom, hoverMat);
        line.computeLineDistances();
        line.renderOrder = 4;
        line.frustumCulled = false;
        group.add(line);
      }
    }
  }

  function fireChange() {
    for (const cb of callbacks) cb();
  }

  return {
    group,
    startDrawing(faceIndex, frame, ringWorld) {
      active = { faceIndex, inProgress: [], ringWorld };
      frames.set(faceIndex, frame);
      hoverPos = null;
      rebuild();
      fireChange();
    },
    addVertex(p) {
      if (!active) return { added: false, closed: false };
      const verts = active.inProgress;
      // Snap to first?
      if (verts.length >= 3) {
        const f = verts[0];
        const dx = f.x - p.x,
          dy = f.y - p.y,
          dz = f.z - p.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < SNAP_RADIUS_M) {
          // Sluit polygon, sla op
          const fIdx = active.faceIndex;
          if (!zones.has(fIdx)) zones.set(fIdx, []);
          zones.get(fIdx)!.push({ verts: verts.slice() });
          active = null;
          hoverPos = null;
          rebuild();
          fireChange();
          return { added: false, closed: true };
        }
      }
      verts.push({ x: p.x, y: p.y, z: p.z });
      rebuild();
      return { added: true, closed: false };
    },
    setHover(p) {
      if (!active) return;
      hoverPos = p.clone();
      rebuild();
    },
    finishDrawing() {
      if (!active || active.inProgress.length < 3) return false;
      const fIdx = active.faceIndex;
      if (!zones.has(fIdx)) zones.set(fIdx, []);
      zones.get(fIdx)!.push({ verts: active.inProgress.slice() });
      active = null;
      hoverPos = null;
      rebuild();
      fireChange();
      return true;
    },
    cancel() {
      active = null;
      hoverPos = null;
      rebuild();
      fireChange();
    },
    isDrawing() {
      return active !== null;
    },
    activeFaceIndex() {
      return active?.faceIndex ?? null;
    },
    popZone(fIdx) {
      const arr = zones.get(fIdx);
      if (!arr || arr.length === 0) return false;
      arr.pop();
      if (arr.length === 0) zones.delete(fIdx);
      rebuild();
      fireChange();
      return true;
    },
    clearFace(fIdx) {
      if (zones.delete(fIdx)) {
        rebuild();
        fireChange();
      }
    },
    setZones(newZones, newFrames) {
      zones.clear();
      for (const [k, v] of newZones) zones.set(k, v);
      for (const [k, v] of newFrames) frames.set(k, v);
      rebuild();
      fireChange();
    },
    getZones() {
      return new Map(zones);
    },
    getEffectiveAreaForFace(fIdx) {
      const arr = zones.get(fIdx);
      if (!arr || arr.length === 0) return 0;
      const frame = frames.get(fIdx);
      if (!frame) return 0;
      let total = 0;
      for (const z of arr) {
        const verts2d = z.verts.map((v) => projectToPlane(frame, new THREE.Vector3(v.x, v.y, v.z)));
        total += polygonArea2D(verts2d);
      }
      return total;
    },
    onChange(cb) {
      callbacks.push(cb);
    },
  };
}
