import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { createSceneRoot } from './scene/sceneRoot';

// BVH-accelerated raycast (10-50x sneller dan default voor grote meshes)
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;
import { fetchBagBuildings } from './geo/bag';
import { fetchTopoBackground, type TopoVariant } from './geo/aerial';
import { buildBuildingsLayer } from './scene/buildings';
import { buildGroundLayer } from './scene/ground';
import { buildSunLight } from './scene/lighting';
import { buildEyeHeightLayer } from './scene/eyeHeightLayer';
import { buildTimeStrip } from './ui/timeStrip';
import { buildOverlayToggles } from './ui/overlayToggles';
import { ExposureAccumulator } from './exposure/accumulator';
import { buildViridisLUT } from './exposure/colormap';
import {
  terrasZomerAvond,
  terrasZomerDag,
  kasJaar,
  kasWinter,
  kasGroeiseizoen,
  type TimeSamples,
} from './exposure/timeWindows';
import { computeUurCurve, computeMaandGrafiek } from './exposure/raycastSun';
import { findBestSpot } from './exposure/findBestSpot';
import { computeRoofPV, type RoofPVResult } from './exposure/pvCalc';
import { buildBestSpotPin } from './scene/bestSpotPin';
import { buildPolygonDrawer, type Vert } from './scene/polygonDrawer';
import { applyPvColors, clearPvColors } from './scene/roofColoring';
import { buildRoofZoneDrawer, type RoofZone } from './scene/roofZoneDrawer';
import { buildRoofFrame, type RoofFrame } from './scene/roofPlane';
import { renderUurCurve } from './ui/chartUurcurve';
import { renderMaandGrafiek } from './ui/chartMaandgrafiek';
import { buildLocationPicker } from './ui/locationPicker';
import { buildModeManager, type ModeDef, type ModeId } from './modes/modeManager';
import { SCENE, HOUSE } from './config';

const host = document.getElementById('canvas-host');
if (!host) throw new Error('canvas-host element ontbreekt in index.html');

const banner = document.getElementById('loading-banner') as HTMLDivElement | null;
function setLoading(text: string | null) {
  if (!banner) return;
  if (text) {
    banner.hidden = false;
    banner.textContent = text;
  } else {
    banner.hidden = true;
  }
}

// Adres-picker in de topbar
const locPickerHost = document.getElementById('location-picker');
if (locPickerHost) buildLocationPicker(locPickerHost);

// Update <title> en h1 met huidig adres
document.title = `Zon — ${HOUSE.address}`;

const root = createSceneRoot(host);

// Tijdelijke grijze grond totdat luchtfoto er is
let groundLayer = buildGroundLayer(null, SCENE.groundSizeM);
root.scene.add(groundLayer.mesh);

// Zon — initieel: nu
const initialDate = new Date();
const sun = buildSunLight(initialDate);
root.scene.add(sun.group);

root.start();

// House marker — staat altijd op origin
const marker = new THREE.Mesh(
  new THREE.ConeGeometry(1.2, 4, 16),
  new THREE.MeshBasicMaterial({ color: 0xff5040, transparent: true, opacity: 0.85 }),
);
marker.rotation.x = Math.PI;
marker.position.set(0, 22, 0);
marker.name = 'house-marker';
root.scene.add(marker);

// UI: tijd-strip
const timeStripHost = document.getElementById('time-strip')!;
const timeStrip = buildTimeStrip(timeStripHost, {
  initialDate,
  onChange: (date) => sun.setDate(date),
});

// UI: overlay-toggles
const togglesHost = document.getElementById('overlay-toggles')!;
buildOverlayToggles(togglesHost, [
  {
    key: 'aerial',
    label: 'Kaart',
    initial: true,
    onChange: (v) => groundLayer.setAerialVisible(v),
  },
  {
    key: 'marker',
    label: 'Huis-marker',
    initial: true,
    onChange: (v) => (marker.visible = v),
  },
]);

// Lees opgeslagen achtergrond-instellingen
const BG_KEY = `bg-variant:${HOUSE.rd.x},${HOUSE.rd.y}`;
const BG_KAD_KEY = `bg-kadaster:${HOUSE.rd.x},${HOUSE.rd.y}`;
let bgVariant: TopoVariant =
  (localStorage.getItem(BG_KEY) as TopoVariant) || 'pastel';
let bgKadaster: boolean = localStorage.getItem(BG_KAD_KEY) === '1';

// Async: laad gebouwen + topo-achtergrond parallel
(async () => {
  setLoading('Gebouwen + kaart laden…');
  try {
    const [bag, aerial] = await Promise.all([
      fetchBagBuildings(),
      fetchTopoBackground({
        radiusM: SCENE.aerialBboxRadiusM,
        pixelSize: SCENE.aerialPixelSize,
        variant: bgVariant,
        withKadaster: bgKadaster,
      }),
    ]);

    // Vervang grijze grond door topo-grond
    root.scene.remove(groundLayer.mesh);
    groundLayer = buildGroundLayer(aerial.texture, aerial.sizeM);
    root.scene.add(groundLayer.mesh);
    const aerialToggle = togglesHost.querySelector<HTMLInputElement>('input[type=checkbox]');
    groundLayer.setAerialVisible(aerialToggle?.checked ?? true);

    // Voeg gebouwen toe
    const buildings = buildBuildingsLayer(bag);
    root.scene.add(buildings.group);

    // Bouw BVH voor walls + roofs zodat raycast snel is
    (buildings.walls.geometry as any).computeBoundsTree();
    (buildings.roofs.geometry as any).computeBoundsTree();

    // === Heatmap-infrastructuur (terras + kas delen LUT) ===
    const TERRAS_WORLD_SIZE = 50; // 50×50m rond huis (tuin-focus)
    const TERRAS_RES = 256;
    const TERRAS_HEIGHT = 1.0;
    const KAS_WORLD_SIZE = 70;
    const KAS_RES = 256;
    const KAS_HEIGHT = 0.05;

    const accumulator = new ExposureAccumulator({
      resolution: TERRAS_RES,
      worldSizeM: TERRAS_WORLD_SIZE,
      measureHeight: TERRAS_HEIGHT,
      shadowCasters: buildings.group,
      renderer: root.renderer,
    });
    const kasAccumulator = new ExposureAccumulator({
      resolution: KAS_RES,
      worldSizeM: KAS_WORLD_SIZE,
      measureHeight: KAS_HEIGHT,
      shadowCasters: buildings.group,
      renderer: root.renderer,
    });

    const lut = buildViridisLUT();
    const eyeLayer = buildEyeHeightLayer({
      worldSizeM: TERRAS_WORLD_SIZE,
      measureHeight: TERRAS_HEIGHT,
      exposureTexture: accumulator.getTexture(),
      colormapLUT: lut,
      totalSamples: 1,
      intervalMinutes: 10,
    });
    root.scene.add(eyeLayer.mesh);

    // Kas-laag: zelfde concept, maar groter (70m) en hoogte op grondvlak
    const kasLayer = buildEyeHeightLayer({
      worldSizeM: KAS_WORLD_SIZE,
      measureHeight: KAS_HEIGHT,
      exposureTexture: kasAccumulator.getTexture(),
      colormapLUT: lut,
      totalSamples: 1,
      intervalMinutes: 30,
    });
    kasLayer.mesh.name = 'kas-heatmap-layer';
    root.scene.add(kasLayer.mesh);

    // === Polygon-tekenaar + best-spot pin ===
    const polyDrawer = buildPolygonDrawer();
    root.scene.add(polyDrawer.group);
    const bestSpotPin = buildBestSpotPin();
    root.scene.add(bestSpotPin.group);

    // Custom polygon laden uit localStorage
    const POLY_KEY = 'custom-polygon';
    const savedPoly = localStorage.getItem(POLY_KEY);
    if (savedPoly) {
      try {
        const parsed = JSON.parse(savedPoly) as Vert[];
        if (Array.isArray(parsed) && parsed.length >= 3) polyDrawer.setPolygon(parsed);
      } catch {
        // ignore
      }
    }
    polyDrawer.onChange((p) => {
      if (p) localStorage.setItem(POLY_KEY, JSON.stringify(p));
      else localStorage.removeItem(POLY_KEY);
    });

    // Heatmap-toggle aan de overlay-toggles toevoegen
    const heatmapToggleLabel = document.createElement('label');
    const heatmapCb = document.createElement('input');
    heatmapCb.type = 'checkbox';
    heatmapCb.checked = false;
    heatmapCb.addEventListener('change', () => {
      eyeLayer.setVisible(heatmapCb.checked);
    });
    heatmapToggleLabel.append(heatmapCb, document.createTextNode(' Heatmap'));
    togglesHost.appendChild(heatmapToggleLabel);

    // Topo-kaart variant + kadasterlijnen toggle
    const bgPanel = document.createElement('div');
    bgPanel.style.cssText =
      'display:flex; flex-direction:column; gap:4px; margin-top:8px; padding-top:8px; border-top:1px solid var(--border);';
    bgPanel.innerHTML = `
      <label style="display:flex; flex-direction:column; gap:3px; cursor:default;">
        <span style="font-size:10px; color: var(--muted); text-transform:uppercase;">Kaart-stijl</span>
        <select id="bg-variant" style="background:var(--panel); border:1px solid var(--border); color:var(--text); padding:3px 5px; border-radius:3px; font-size:11px; cursor:pointer;">
          <option value="pastel">🗺 Pastel</option>
          <option value="grijs">🗺 Grijs (heatmap-vriendelijk)</option>
        </select>
      </label>
      <label style="display:flex; align-items:center; gap:6px; cursor:pointer; margin-top:4px;">
        <input type="checkbox" id="bg-kadaster" />
        <span style="font-size:11px;">Kadasterlijnen</span>
      </label>
    `;
    togglesHost.appendChild(bgPanel);

    const bgSelect = bgPanel.querySelector<HTMLSelectElement>('#bg-variant')!;
    bgSelect.value = bgVariant;
    const kadCb = bgPanel.querySelector<HTMLInputElement>('#bg-kadaster')!;
    kadCb.checked = bgKadaster;

    async function reloadBg() {
      bgSelect.disabled = true;
      kadCb.disabled = true;
      try {
        const res = await fetchTopoBackground({
          radiusM: SCENE.aerialBboxRadiusM,
          pixelSize: SCENE.aerialPixelSize,
          variant: bgVariant,
          withKadaster: bgKadaster,
        });
        groundLayer.setBackgroundTexture(res.texture);
      } catch (err) {
        console.error(err);
      } finally {
        bgSelect.disabled = false;
        kadCb.disabled = false;
      }
    }

    bgSelect.addEventListener('change', () => {
      bgVariant = bgSelect.value as TopoVariant;
      localStorage.setItem(BG_KEY, bgVariant);
      reloadBg();
    });
    kadCb.addEventListener('change', () => {
      bgKadaster = kadCb.checked;
      localStorage.setItem(BG_KAD_KEY, bgKadaster ? '1' : '0');
      reloadBg();
    });

    type HeatmapKind = 'terras' | 'kas';
    function setHeatmapVisible(v: boolean, kind: HeatmapKind = 'terras') {
      heatmapCb.checked = v;
      if (kind === 'terras') {
        eyeLayer.setVisible(v);
        kasLayer.setVisible(false);
      } else {
        eyeLayer.setVisible(false);
        kasLayer.setVisible(v);
      }
    }

    // === Modus-manager: 4 tabs ===
    const tabsHost = document.getElementById('mode-tabs')!;
    const controlsHost = document.getElementById('mode-controls')!;
    type TerrasView = 'totaal' | 'laatste';
    let lastTerrasResult: { sunSamples: number; samples: ReturnType<typeof terrasZomerAvond> } | null = null;
    let terrasView: TerrasView = 'totaal';

    function applyTerrasView() {
      eyeLayer.setActiveTexture(
        terrasView === 'totaal' ? accumulator.getTexture() : accumulator.getLastSunTexture(),
      );
    }

    let lastPvResults: RoofPVResult[] | null = null;
    let updatePvSummaryRef: (() => void) | null = null;

    // === Roof-zone drawer voor het aangeven van paneel-zones binnen een dakvlak ===
    const roofZoneDrawer = buildRoofZoneDrawer();
    root.scene.add(roofZoneDrawer.group);
    roofZoneDrawer.group.visible = false;
    const ZONES_KEY = 'pv-roof-zones';
    function saveRoofZones() {
      const obj: Record<string, RoofZone[]> = {};
      for (const [k, v] of roofZoneDrawer.getZones()) obj[String(k)] = v;
      localStorage.setItem(ZONES_KEY, JSON.stringify(obj));
    }
    function loadRoofZones(faceFrames: Map<number, RoofFrame>) {
      try {
        const raw = localStorage.getItem(ZONES_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw) as Record<string, RoofZone[]>;
        const m = new Map<number, RoofZone[]>();
        for (const [k, v] of Object.entries(obj)) m.set(Number(k), v);
        roofZoneDrawer.setZones(m, faceFrames);
      } catch {
        // ignore
      }
    }
    roofZoneDrawer.onChange(() => {
      saveRoofZones();
      if (updatePvSummaryRef) updatePvSummaryRef();
      // Re-paint roof colors zodat eventueel verandering doorklikt
      if (lastPvResults)
        applyPvColors(bag.roofs, bag.roofTriangleToFace, lastPvResults, excludedRoofFaces);
    });

    // Map met frames voor elk dakvlak (gebruikt door de drawer)
    const roofFrames = new Map<number, RoofFrame>();
    for (const f of bag.roofFaces) {
      roofFrames.set(f.faceIndex, buildRoofFrame(f.azimuthDeg, f.tiltDeg, f.centroidLocal));
    }
    loadRoofZones(roofFrames);

    /** Effectieve oppervlakte voor PV-berekening.
     *   - Als zones zijn getekend → som van zone-areas (overrided slider)
     *   - Anders, als slider <100% → fallbackArea × pct/100
     *   - Anders → fallbackArea
     */
    function effectiveAreaForFace(faceIdx: number, fallbackArea: number): number {
      const a = roofZoneDrawer.getEffectiveAreaForFace(faceIdx);
      if (a > 0) return a;
      const pct = roofPct.get(faceIdx);
      if (pct !== undefined && pct < 100) return (fallbackArea * pct) / 100;
      return fallbackArea;
    }
    /** Gebruikt de gebruiker zones voor dit dakvlak? */
    function hasZones(faceIdx: number): boolean {
      return roofZoneDrawer.getEffectiveAreaForFace(faceIdx) > 0;
    }
    /** Geeft het bruikbare percentage als de slider gebruikt wordt (zonder zones). */
    function usablePct(faceIdx: number): number {
      return roofPct.get(faceIdx) ?? 100;
    }

    // Per-dakvlak: percentage van het oppervlak dat bruikbaar is (0..100)
    const PCT_KEY = 'pv-roof-pct';
    const roofPct = new Map<number, number>();
    try {
      const raw = localStorage.getItem(PCT_KEY);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) roofPct.set(Number(k), v);
      }
    } catch {
      // ignore
    }
    function saveRoofPct() {
      const obj: Record<string, number> = {};
      for (const [k, v] of roofPct) obj[String(k)] = v;
      localStorage.setItem(PCT_KEY, JSON.stringify(obj));
    }

    // Per-dakvlak uitgesloten markeringen (rieten kap, dakkapellen, nokvlakken)
    const EXCLUDED_KEY = 'pv-excluded-roof-faces';
    let excludedRoofFaces = new Set<number>();
    try {
      const raw = localStorage.getItem(EXCLUDED_KEY);
      if (raw) excludedRoofFaces = new Set(JSON.parse(raw) as number[]);
    } catch {
      // ignore
    }
    function saveExcluded() {
      localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...excludedRoofFaces]));
    }

    type KasView = 'jaar' | 'winter' | 'groei';
    let kasView: KasView = 'jaar';
    let lastKasResult: {
      samples: TimeSamples;
      sunSamplesAdded: number;
      maxPossibleAvgHours: number;
      avgSunHoursPerDay: number;
    } | null = null;
    let kasBestSpotInfo: { worldX: number; worldZ: number; value: number } | null = null;

    function updateKasBestSpot() {
      const polygon = polyDrawer.getPolygon();
      if (!lastKasResult || !polygon) {
        if (modeMgr?.current() === 'kas') bestSpotPin.setVisible(false);
        kasBestSpotInfo = null;
        return;
      }
      const result = findBestSpot(
        kasAccumulator,
        [polygon],
        'totaal',
        KAS_WORLD_SIZE,
        KAS_RES,
        root.renderer,
      );
      if (!result) {
        bestSpotPin.setVisible(false);
        kasBestSpotInfo = null;
        return;
      }
      bestSpotPin.setPosition(result.worldX, result.worldZ);
      bestSpotPin.setVisible(true);
      kasBestSpotInfo = result;
    }

    let bestSpotInfo: { worldX: number; worldZ: number; value: number } | null = null;
    function updateBestSpot() {
      const polygon = polyDrawer.getPolygon();
      if (!lastTerrasResult || !polygon) {
        bestSpotPin.setVisible(false);
        bestSpotInfo = null;
        return;
      }
      const result = findBestSpot(
        accumulator,
        [polygon],
        terrasView,
        TERRAS_WORLD_SIZE,
        TERRAS_RES,
        root.renderer,
      );
      if (!result) {
        bestSpotPin.setVisible(false);
        bestSpotInfo = null;
        return;
      }
      bestSpotPin.setPosition(result.worldX, result.worldZ);
      bestSpotPin.setVisible(true);
      bestSpotInfo = result;
    }
    polyDrawer.onChange(() => {
      updateBestSpot();
      updateKasBestSpot();
    });

    const modes: ModeDef[] = [
      {
        id: 'live',
        label: 'Live schaduw',
        icon: '☀',
        activate(host) {
          setHeatmapVisible(false);
          const hint = document.createElement('span');
          hint.className = 'hint';
          hint.textContent =
            'Sleep met de tijd-/datum-strip onderaan om de schaduw door de dag te zien bewegen.';
          host.appendChild(hint);
        },
        deactivate() {},
      },
      {
        id: 'terras',
        label: 'Terras',
        icon: '🪑',
        activate(host) {
          root.camera.position.set(0, 70, 0.1);
          root.controls.target.set(0, 0, 0);
          root.controls.update();
          if (lastTerrasResult) {
            setHeatmapVisible(true);
            updateBestSpot();
          }
          polyDrawer.group.visible = true;
          applyTerrasView();

          const btn = document.createElement('button');
          btn.textContent = lastTerrasResult ? '↻ Opnieuw berekenen' : '☀ Bereken (1 jul, 16:00–22:00)';

          // View-modus dropdown
          const viewSel = document.createElement('select');
          viewSel.title = 'Wat toont de heatmap?';
          [
            { v: 'totaal', label: '📊 Totale zonuren' },
            { v: 'laatste', label: '🌅 Tot hoe laat zon' },
          ].forEach((o) => {
            const opt = document.createElement('option');
            opt.value = o.v;
            opt.textContent = o.label;
            if (o.v === terrasView) opt.selected = true;
            viewSel.appendChild(opt);
          });
          viewSel.addEventListener('change', () => {
            terrasView = viewSel.value as TerrasView;
            applyTerrasView();
            updateLegend();
            updateBestSpot();
            updateSummary();
          });

          const summary = document.createElement('span');
          summary.className = 'summary';
          const legend = document.createElement('div');
          legend.className = 'legend';

          function updateLegend() {
            if (terrasView === 'totaal') {
              legend.innerHTML = `
                <span class="legend-label">Geen zon</span>
                <span class="legend-bar"></span>
                <span class="legend-label">Volle 6 uur zon</span>
              `;
            } else {
              legend.innerHTML = `
                <span class="legend-label">Geen / vroeg</span>
                <span class="legend-bar"></span>
                <span class="legend-label">Tot 22:00</span>
              `;
            }
          }
          updateLegend();

          function updateSummary() {
            if (!lastTerrasResult) {
              summary.className = 'hint';
              summary.textContent =
                'Klik op "☀ Bereken" om de heatmap voor een typische zomer-avond te genereren.';
              return;
            }
            summary.className = 'summary';
            const polyHint = polyDrawer.getPolygon() === null
              ? ' Teken een zoekgebied om de beste plek aan te wijzen.'
              : '';
            if (bestSpotInfo && terrasView === 'totaal') {
              const bestHrs = bestSpotInfo.value * 6;
              summary.textContent = `🏆 Beste plek in jouw zoekgebied krijgt ${bestHrs.toFixed(1)}h zon binnen 16-22h.`;
            } else if (bestSpotInfo && terrasView === 'laatste') {
              const lastTime = 16 + bestSpotInfo.value * 6;
              const h = Math.floor(lastTime);
              const m = Math.round((lastTime - h) * 60);
              summary.textContent = `🏆 Beste avondzon-plek krijgt zon tot ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}.`;
            } else {
              summary.textContent = `Heatmap berekend voor 16:00–22:00.${polyHint}`;
            }
          }
          // updateSummary opnieuw aanroepen wanneer polygon verandert
          polyDrawer.onChange(() => updateSummary());
          updateSummary();

          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Berekenen…';
            try {
              await new Promise((r) => setTimeout(r, 16));
              const samples = terrasZomerAvond();
              accumulator.reset();
              const contribution = 1.0 / samples.dates.length;
              const sunSamples = accumulator.addAll(samples, contribution);
              eyeLayer.setExposure(
                accumulator.getTexture(),
                samples.dates.length,
                samples.intervalMinutes,
              );
              applyTerrasView();
              setHeatmapVisible(true);
              lastTerrasResult = { sunSamples, samples };
              btn.textContent = '↻ Opnieuw berekenen';
              updateBestSpot();
              updateSummary();
              console.log(`[Terras] ${samples.label} — ${samples.dates.length} samples, ${sunSamples} boven horizon`);
            } finally {
              btn.disabled = false;
            }
          });

          // Teken-zoekgebied controls
          const drawBtn = document.createElement('button');
          const clearBtn = document.createElement('button');
          clearBtn.textContent = '🗑 Wis zoekgebied';
          const hint = document.createElement('span');
          hint.className = 'hint';

          function syncDrawButtons() {
            const hasPoly = polyDrawer.getPolygon() !== null;
            const isDrawing = polyDrawer.isDrawing();
            if (isDrawing) {
              drawBtn.textContent = '✗ Annuleer tekenen';
              hint.textContent =
                'Klik 3+ hoeken op de kaart. Klik op het oranje bolletje (eerste hoek) om te sluiten.';
              clearBtn.style.display = 'none';
            } else if (hasPoly) {
              drawBtn.textContent = '✏ Teken nieuw zoekgebied';
              hint.textContent = '';
              clearBtn.style.display = '';
            } else {
              drawBtn.textContent = '✏ Teken zoekgebied';
              hint.textContent = 'Teken een polygon rond je tuin om binnen dat gebied de beste terras-plek te bepalen.';
              clearBtn.style.display = 'none';
            }
          }
          drawBtn.addEventListener('click', () => {
            if (polyDrawer.isDrawing()) polyDrawer.cancel();
            else polyDrawer.startDrawing();
            syncDrawButtons();
          });
          clearBtn.addEventListener('click', () => {
            polyDrawer.reset();
            syncDrawButtons();
          });
          polyDrawer.onChange(() => syncDrawButtons());

          host.append(btn, viewSel, summary, drawBtn, clearBtn, legend, hint);
          syncDrawButtons();
        },
        deactivate() {
          setHeatmapVisible(false);
          bestSpotPin.setVisible(false);
          polyDrawer.group.visible = false;
          if (polyDrawer.isDrawing()) polyDrawer.cancel();
        },
      },
      {
        id: 'kas',
        label: 'Kas',
        icon: '🌱',
        activate(host) {
          root.camera.position.set(0, 80, 0.1);
          root.controls.target.set(0, 0, 0);
          root.controls.update();
          if (lastKasResult) {
            setHeatmapVisible(true, 'kas');
            updateKasBestSpot();
          }
          polyDrawer.group.visible = true;

          const btn = document.createElement('button');
          btn.textContent = lastKasResult ? '↻ Opnieuw berekenen' : '🌱 Bereken kas-zonuren (jaar)';

          const viewSel = document.createElement('select');
          viewSel.title = 'Welke periode?';
          [
            { v: 'jaar', label: '📆 Hele jaar' },
            { v: 'winter', label: '❄️ Winter (okt-mrt)' },
            { v: 'groei', label: '🌿 Groeiseizoen (apr-sep)' },
          ].forEach((o) => {
            const opt = document.createElement('option');
            opt.value = o.v;
            opt.textContent = o.label;
            if (o.v === kasView) opt.selected = true;
            viewSel.appendChild(opt);
          });
          viewSel.addEventListener('change', async () => {
            kasView = viewSel.value as KasView;
            await runKasCompute();
          });

          const summary = document.createElement('span');
          summary.className = 'summary';
          const legend = document.createElement('div');
          legend.className = 'legend';
          legend.innerHTML = `
            <span class="legend-label">Weinig zon</span>
            <span class="legend-bar"></span>
            <span class="legend-label">Veel zon</span>
          `;

          // Polygon-tekening (deelt met terras)
          const drawBtn = document.createElement('button');
          const clearBtn = document.createElement('button');
          clearBtn.textContent = '🗑 Wis zoekgebied';
          const hint = document.createElement('span');
          hint.className = 'hint';

          function syncDrawButtons() {
            const hasPoly = polyDrawer.getPolygon() !== null;
            const isDrawing = polyDrawer.isDrawing();
            if (isDrawing) {
              drawBtn.textContent = '✗ Annuleer tekenen';
              hint.textContent = 'Klik 3+ hoeken. Klik op het oranje bolletje (eerste hoek) om te sluiten.';
              clearBtn.style.display = 'none';
            } else if (hasPoly) {
              drawBtn.textContent = '✏ Teken nieuw zoekgebied';
              hint.textContent = '';
              clearBtn.style.display = '';
            } else {
              drawBtn.textContent = '✏ Teken zoekgebied';
              hint.textContent = 'Teken een polygon rond je tuin om binnen dat gebied de beste kas-plek te bepalen.';
              clearBtn.style.display = 'none';
            }
          }
          drawBtn.addEventListener('click', () => {
            if (polyDrawer.isDrawing()) polyDrawer.cancel();
            else polyDrawer.startDrawing();
            syncDrawButtons();
          });
          clearBtn.addEventListener('click', () => {
            polyDrawer.reset();
            syncDrawButtons();
          });
          polyDrawer.onChange(() => {
            syncDrawButtons();
            updateKasSummary();
          });

          function updateKasSummary() {
            if (!lastKasResult) {
              summary.className = 'hint';
              summary.textContent = 'Klik "🌱 Bereken kas-zonuren" om te starten.';
              return;
            }
            summary.className = 'summary';
            const avgHrs = lastKasResult.avgSunHoursPerDay;
            const periode = kasView === 'winter' ? 'wintermaanden' : kasView === 'groei' ? 'groeiseizoen' : 'het jaar';
            if (kasBestSpotInfo) {
              const bestAvg = kasBestSpotInfo.value * lastKasResult.maxPossibleAvgHours;
              summary.textContent = `🏆 Beste kas-plek krijgt gemiddeld ${bestAvg.toFixed(1)}h direct zon/dag over ${periode} (max in tuin: ${lastKasResult.maxPossibleAvgHours.toFixed(1)}h).`;
            } else if (polyDrawer.getPolygon() === null) {
              summary.textContent = `Heatmap berekend (gem. zonuren/dag, ${periode}). Teken een zoekgebied om de beste plek aan te wijzen.`;
            } else {
              summary.textContent = `Gem. zonuren/dag over ${periode}.`;
            }
            void avgHrs;
          }

          async function runKasCompute() {
            btn.disabled = true;
            const oldText = btn.textContent;
            btn.textContent = 'Berekenen…';
            try {
              await new Promise((r) => setTimeout(r, 16));
              const samples =
                kasView === 'winter' ? kasWinter() : kasView === 'groei' ? kasGroeiseizoen() : kasJaar();
              kasAccumulator.reset();
              const contribution = 1.0 / samples.dates.length;
              const sunSamplesAdded = kasAccumulator.addAll(samples, contribution);
              kasLayer.setExposure(
                kasAccumulator.getTexture(),
                samples.dates.length,
                samples.intervalMinutes,
              );
              kasLayer.setActiveTexture(kasAccumulator.getTexture());
              setHeatmapVisible(true, 'kas');
              // Bereken stats: hoeveel uur per dag bij volle zon (max 1.0 in textuur)
              const monthCount = kasView === 'jaar' ? 12 : 6;
              const totalHoursWindow = (samples.dates.length * samples.intervalMinutes) / 60;
              const maxPossibleAvgHours = totalHoursWindow / monthCount;
              const avgSunHoursPerDay = (sunSamplesAdded * samples.intervalMinutes) / 60 / monthCount;
              lastKasResult = {
                samples,
                sunSamplesAdded,
                maxPossibleAvgHours,
                avgSunHoursPerDay,
              };
              btn.textContent = '↻ Opnieuw berekenen';
              updateKasBestSpot();
              updateKasSummary();
            } catch (err) {
              console.error(err);
              btn.textContent = oldText ?? '🌱 Bereken';
            } finally {
              btn.disabled = false;
            }
          }
          btn.addEventListener('click', () => runKasCompute());

          host.append(btn, viewSel, summary, drawBtn, clearBtn, legend, hint);
          syncDrawButtons();
          updateKasSummary();
        },
        deactivate() {
          setHeatmapVisible(false, 'kas');
          bestSpotPin.setVisible(false);
          if (polyDrawer.isDrawing()) polyDrawer.cancel();
        },
      },
      {
        id: 'pv',
        label: 'Zonnepanelen',
        icon: '⚡',
        activate(host) {
          // Camera iets schuiner zodat je de daken goed ziet
          root.camera.position.set(35, 45, 35);
          root.controls.target.set(0, 5, 0);
          root.controls.update();
          setHeatmapVisible(false);
          buildings.setPvColorMode(true);
          roofZoneDrawer.group.visible = true;
          if (lastPvResults)
            applyPvColors(bag.roofs, bag.roofTriangleToFace, lastPvResults, excludedRoofFaces);

          const btn = document.createElement('button');
          btn.textContent = lastPvResults ? '↻ Opnieuw berekenen' : '⚡ Bereken dakvlakken (jaar)';

          const summary = document.createElement('span');
          summary.className = 'summary';
          const legend = document.createElement('div');
          legend.className = 'legend';
          legend.innerHTML = `
            <span class="legend-label">< 90 kWh/m²/jr</span>
            <span class="legend-bar" style="background: linear-gradient(to right, rgb(166,31,21), rgb(242,82,30), rgb(242,168,30), rgb(102,199,46), rgb(46,158,82))"></span>
            <span class="legend-label">> 200 kWh/m²/jr</span>
          `;

          // Reset-knop voor uitgesloten dakvlakken
          const resetExcludeBtn = document.createElement('button');
          resetExcludeBtn.style.fontSize = '11px';
          function syncResetBtn() {
            const n = excludedRoofFaces.size;
            resetExcludeBtn.textContent = n > 0 ? `↺ Reset ${n} ongeschikte daken` : '';
            resetExcludeBtn.style.display = n > 0 ? '' : 'none';
          }
          resetExcludeBtn.addEventListener('click', () => {
            excludedRoofFaces.clear();
            saveExcluded();
            if (lastPvResults)
              applyPvColors(bag.roofs, bag.roofTriangleToFace, lastPvResults, excludedRoofFaces);
            updatePvSummary();
            syncResetBtn();
          });

          function fmtKwh(v: number) {
            return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);
          }
          // Helper: filter resultaten op alleen geschikte (niet-uitgesloten) dakvlakken
          (window as any).__getEligiblePv = () =>
            (lastPvResults ?? []).filter((r) => !excludedRoofFaces.has(r.faceIndex));

          function updatePvSummary() {
            if (!lastPvResults) {
              summary.className = 'hint';
              summary.textContent =
                `Bereken voor alle ${bag.roofFaces.length} dakvlakken in de buurt de jaarlijkse PV-opbrengst.`;
              return;
            }
            // Voor elk vlak: pas effectiveArea toe
            const eligible = lastPvResults
              .filter((r) => !excludedRoofFaces.has(r.faceIndex))
              .map((r) => {
                const effArea = effectiveAreaForFace(r.faceIndex, r.area);
                return {
                  ...r,
                  effectiveArea: effArea,
                  effectiveTotalKwh: r.actualPerM2 * effArea,
                  hasZone: hasZones(r.faceIndex),
                };
              });
            const totalKwh = eligible.reduce((s, r) => s + r.effectiveTotalKwh, 0);
            const top = [...eligible].sort((a, b) => b.effectiveTotalKwh - a.effectiveTotalKwh)[0];
            const zonedCnt = eligible.filter((r) => r.hasZone).length;
            summary.className = 'summary';
            const excludedCnt = excludedRoofFaces.size;
            const parts: string[] = [];
            parts.push(`${eligible.length} dakvlakken bruikbaar`);
            if (excludedCnt > 0) parts.push(`${excludedCnt} uitgesloten`);
            if (zonedCnt > 0) parts.push(`${zonedCnt} met paneelzone`);
            if (top) {
              summary.textContent =
                `${parts.join(' · ')}. Totaal: ${fmtKwh(totalKwh)} kWh/jr. ` +
                `Beste: ${fmtKwh(top.effectiveTotalKwh)} kWh/jr (${top.azimuthLabel}, ${top.tiltDeg.toFixed(0)}°). ` +
                `Klik op een dak voor details, markeren of paneelzone tekenen.`;
            } else {
              summary.textContent = `Geen dakvlakken meer beschikbaar.`;
            }
            syncResetBtn();
          }
          updatePvSummary();
          updatePvSummaryRef = updatePvSummary;

          btn.addEventListener('click', async () => {
            btn.disabled = true;
            const oldText = btn.textContent;
            btn.textContent = 'Berekenen…';
            try {
              await new Promise((r) => setTimeout(r, 16));
              const t0 = performance.now();
              lastPvResults = computeRoofPV(
                bag.roofFaces.map((f) => ({
                  buildingId: f.buildingId,
                  faceIndex: f.faceIndex,
                  azimuthDeg: f.azimuthDeg,
                  tiltDeg: f.tiltDeg,
                  area: f.area,
                  centroidLocal: f.centroidLocal,
                  ringWorld: f.ringWorld,
                })),
                buildings.group,
              );
              const dt = performance.now() - t0;
              applyPvColors(bag.roofs, bag.roofTriangleToFace, lastPvResults, excludedRoofFaces);
              btn.textContent = '↻ Opnieuw berekenen';
              updatePvSummary();
              console.log(
                `[PV] ${lastPvResults.length} dakvlakken in ${dt.toFixed(0)}ms`,
              );
            } catch (err) {
              console.error(err);
              btn.textContent = oldText ?? '⚡ Bereken';
            } finally {
              btn.disabled = false;
            }
          });

          host.append(btn, resetExcludeBtn, summary, legend);
          syncResetBtn();
        },
        deactivate() {
          buildings.setPvColorMode(false);
          clearPvColors(bag.roofs);
          if (roofZoneDrawer.isDrawing()) roofZoneDrawer.cancel();
          roofZoneDrawer.group.visible = false;
          updatePvSummaryRef = null;
        },
      },
    ];

    const modeMgr = buildModeManager(tabsHost, controlsHost, modes, 'live');

    // === Drawing-banner: toon "annuleer"-knop wanneer een drawer actief is ===
    const drawingBanner = document.getElementById('drawing-banner') as HTMLDivElement;
    function updateDrawingBanner() {
      if (polyDrawer.isDrawing()) {
        drawingBanner.hidden = false;
        drawingBanner.innerHTML = `
          <span class="draw-hint">✏ Tuin-zoekgebied tekenen</span>
          <span style="color: var(--muted); font-size: 12px;">Klik 3+ hoeken, klik op het oranje bolletje om te sluiten</span>
          <button id="cancel-draw">✗ Annuleer (Esc)</button>
        `;
        drawingBanner
          .querySelector<HTMLButtonElement>('#cancel-draw')
          ?.addEventListener('click', () => {
            polyDrawer.cancel();
            updateDrawingBanner();
          });
      } else if (roofZoneDrawer.isDrawing()) {
        drawingBanner.hidden = false;
        drawingBanner.innerHTML = `
          <span class="draw-hint">📐 Paneelzone tekenen</span>
          <span style="color: var(--muted); font-size: 12px;">Klik 3+ hoeken op het dakvlak, klik op het oranje bolletje om te sluiten</span>
          <button id="cancel-draw">✗ Annuleer (Esc)</button>
        `;
        drawingBanner
          .querySelector<HTMLButtonElement>('#cancel-draw')
          ?.addEventListener('click', () => {
            roofZoneDrawer.cancel();
            updateDrawingBanner();
          });
      } else {
        drawingBanner.hidden = true;
        drawingBanner.innerHTML = '';
      }
    }
    polyDrawer.onChange(updateDrawingBanner);
    roofZoneDrawer.onChange(updateDrawingBanner);

    // ESC-toets: annuleer welke drawer ook actief is
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (polyDrawer.isDrawing()) {
        polyDrawer.cancel();
        updateDrawingBanner();
      } else if (roofZoneDrawer.isDrawing()) {
        roofZoneDrawer.cancel();
        updateDrawingBanner();
      }
    });

    // === Click-handler: alleen actief in Terras-modus, raycast naar eye-layer ===
    const infoPanel = document.getElementById('info-panel') as HTMLElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let chartInstance: ReturnType<typeof renderUurCurve> | null = null;

    const canvasEl = host!;
    function ndcFromEvent(e: MouseEvent) {
      const rect = canvasEl.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      // Forceer matrices up-to-date — anders kan een raycast direct na een GPU-pas
      // soms een verouderde camera-matrix gebruiken.
      root.camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, root.camera);
    }
    /** Raycast naar grond-niveau (y=0). Returns wereldpositie of null. */
    function pickGround(): { x: number; z: number } | null {
      // Eerst proberen via eye-layer (precies); anders via grondvlak
      const hits = raycaster.intersectObject(eyeLayer.mesh, false);
      if (hits.length > 0) return { x: hits[0].point.x, z: hits[0].point.z };
      const groundHits = raycaster.intersectObject(groundLayer.mesh, false);
      if (groundHits.length > 0) return { x: groundHits[0].point.x, z: groundHits[0].point.z };
      return null;
    }

    host.addEventListener('mousemove', (e) => {
      const m = modeMgr.current();
      if (m === 'terras' && polyDrawer.isDrawing()) {
        ndcFromEvent(e);
        const p = pickGround();
        if (p) polyDrawer.setHover(p.x, p.z);
      } else if (m === 'pv' && roofZoneDrawer.isDrawing()) {
        ndcFromEvent(e);
        const activeFaceIdx = roofZoneDrawer.activeFaceIndex();
        if (activeFaceIdx === null) return;
        const hits = raycaster.intersectObject(buildings.roofs, false);
        if (hits.length === 0) return;
        const hitFaceIdx = bag.roofTriangleToFace[hits[0].faceIndex ?? -1];
        if (hitFaceIdx !== activeFaceIdx) return;
        const frame = roofFrames.get(activeFaceIdx);
        if (!frame) return;
        const rel = new THREE.Vector3().subVectors(hits[0].point, frame.origin);
        const u = rel.dot(frame.tangent);
        const v = rel.dot(frame.bitangent);
        const onPlane = new THREE.Vector3()
          .copy(frame.origin)
          .addScaledVector(frame.tangent, u)
          .addScaledVector(frame.bitangent, v);
        roofZoneDrawer.setHover(onPlane);
      }
    });

    host.addEventListener('click', (e) => {
      const id: ModeId = modeMgr.current();
      if (id !== 'terras' && id !== 'kas' && id !== 'pv') return;

      ndcFromEvent(e);

      // Drawing-mode: voeg vertex toe (werkt voor beide modi)
      if (polyDrawer.isDrawing()) {
        const p = pickGround();
        if (p) polyDrawer.addVertex(p.x, p.z);
        return;
      }

      if (id === 'pv') {
        if (!lastPvResults) return;

        // Drawing-mode: klik raycast naar de roofs-mesh, vertex toevoegen op het ACTIEVE vlak
        if (roofZoneDrawer.isDrawing()) {
          const activeFaceIdx = roofZoneDrawer.activeFaceIndex();
          if (activeFaceIdx === null) return;
          const hits = raycaster.intersectObject(buildings.roofs, false);
          if (hits.length === 0) return;
          // Negeer hit als het een ander dakvlak is
          const hitFaceIdx = bag.roofTriangleToFace[hits[0].faceIndex ?? -1];
          if (hitFaceIdx !== activeFaceIdx) return;
          // Snap naar het exacte vlak
          const frame = roofFrames.get(activeFaceIdx);
          if (!frame) return;
          // Project hit naar het vlak (kleine ruis verwijderen)
          const rel = new THREE.Vector3().subVectors(hits[0].point, frame.origin);
          const u = rel.dot(frame.tangent);
          const v = rel.dot(frame.bitangent);
          const onPlane = new THREE.Vector3()
            .copy(frame.origin)
            .addScaledVector(frame.tangent, u)
            .addScaledVector(frame.bitangent, v);
          roofZoneDrawer.addVertex(onPlane);
          return;
        }

        const hits = raycaster.intersectObject(buildings.roofs, false);
        if (hits.length === 0) return;
        const hit = hits[0];
        const triIdx = hit.faceIndex ?? -1;
        if (triIdx < 0) return;
        const faceIdx = bag.roofTriangleToFace[triIdx];
        const result = lastPvResults.find((r) => r.faceIndex === faceIdx);
        if (!result) return;

        const isExcluded = excludedRoofFaces.has(faceIdx);
        const hasZone = hasZones(faceIdx);
        const effArea = effectiveAreaForFace(faceIdx, result.area);
        const effectiveTotalKwh = result.actualPerM2 * effArea;
        const PRICE_PER_WP = 1.5;
        const ENERGY_PRICE = 0.32;
        const kWpPerM2 = 0.2;
        const installedKwp = effArea * kWpPerM2;
        const installCost = installedKwp * 1000 * PRICE_PER_WP;
        const annualValue = effectiveTotalKwh * ENERGY_PRICE;
        const paybackYears = installCost > 0 ? installCost / annualValue : 0;

        // Top-3 over alleen geschikte vlakken, gerangschikt op effectieve opbrengst
        const eligibleAll = lastPvResults
          .filter((r) => !excludedRoofFaces.has(r.faceIndex))
          .map((r) => ({
            ...r,
            effectiveArea: effectiveAreaForFace(r.faceIndex, r.area),
            effectiveTotalKwh: r.actualPerM2 * effectiveAreaForFace(r.faceIndex, r.area),
          }));
        const top3 = [...eligibleAll]
          .sort((a, b) => b.effectiveTotalKwh - a.effectiveTotalKwh)
          .slice(0, 3);
        const rankInTop3 = top3.findIndex((r) => r.faceIndex === result.faceIndex);

        // Verdict op basis van terugverdientijd
        let verdict: { icon: string; label: string; color: string };
        if (paybackYears < 7) {
          verdict = { icon: '✓', label: 'Goede keuze', color: '#5fd66e' };
        } else if (paybackYears < 11) {
          verdict = { icon: '○', label: 'Marginaal', color: 'var(--accent)' };
        } else if (paybackYears < 20) {
          verdict = { icon: '△', label: 'Lange terugverdientijd', color: '#ff7a30' };
        } else {
          verdict = { icon: '✗', label: 'Niet rendabel', color: '#ff5050' };
        }

        const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0));
        infoPanel.hidden = false;

        const excludedBanner = isExcluded
          ? `<div style="background:rgba(58,58,58,0.4); border:1px solid #555; border-radius:6px; padding:8px 12px; margin: 8px 0; font-size:12px; color:#bbb;">
              <strong>✗ Gemarkeerd als ongeschikt</strong> — dit vlak telt niet mee in de totalen.
            </div>`
          : '';

        const verdictBanner = !isExcluded
          ? `<div style="background:rgba(${verdict.color === '#5fd66e' ? '95,214,110' : verdict.color === '#ff7a30' ? '255,122,48' : verdict.color === '#ff5050' ? '255,80,80' : '255,180,84'},0.12); border:1px solid ${verdict.color}; border-radius:6px; padding:10px 12px; margin: 8px 0;">
              <div style="font-size:12px; color:${verdict.color}; font-weight:600; margin-bottom:4px;">
                ${verdict.icon} ${verdict.label}
              </div>
              <div style="font-size:24px; font-weight:600; color:var(--text); line-height:1.1;">
                ${paybackYears < 50 ? `~${paybackYears.toFixed(1)} jaar` : '—'}
                <span style="font-size:11px; color:var(--muted); font-weight:400;">terugverdientijd</span>
              </div>
            </div>`
          : '';

        infoPanel.innerHTML = `
          <h3 style="margin:0 0 4px 0; font-size:13px; color:var(--muted); font-weight:500;">⚡ Dakvlak ${result.faceIndex} — ${result.azimuthLabel}, ${result.tiltDeg.toFixed(0)}°, ${result.area.toFixed(0)} m²${!isExcluded && rankInTop3 >= 0 ? ` <span style="background:var(--accent); color:#1a1300; padding:1px 6px; border-radius:3px; font-size:10px; margin-left:4px;">#${rankInTop3 + 1} in buurt</span>` : ''}</h3>

          ${excludedBanner}
          ${verdictBanner}

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">
            <div style="background:var(--bg); border:1px solid var(--border); border-radius:5px; padding:8px;">
              <div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">Opbrengst</div>
              <div style="font-size:18px; color:var(--accent); font-weight:600;">${fmt(effectiveTotalKwh)}</div>
              <div style="font-size:10px; color:var(--muted);">kWh / jaar${hasZone ? ` (${effArea.toFixed(0)} m² zone)` : ''}</div>
            </div>
            <div style="background:var(--bg); border:1px solid var(--border); border-radius:5px; padding:8px;">
              <div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">Waarde</div>
              <div style="font-size:18px; color:var(--accent); font-weight:600;">€&nbsp;${fmt(annualValue)}</div>
              <div style="font-size:10px; color:var(--muted);">per jaar</div>
            </div>
          </div>

          ${
            hasZone
              ? `<div style="background:rgba(255,216,74,0.08); border:1px solid var(--accent); border-radius:5px; padding:8px; margin-bottom:10px; font-size:11px; color:var(--text); line-height:1.5;">
                  <strong>📐 Paneelzone getekend</strong> — ${effArea.toFixed(1)} m² van het ${result.area.toFixed(1)} m² vlak (${((effArea / result.area) * 100).toFixed(0)}%) is bruikbaar voor panelen.
                </div>`
              : ''
          }

          <details style="font-size:12px; color:var(--muted); margin-bottom:8px;">
            <summary style="cursor:pointer; padding:4px 0; user-select:none;">Technische details</summary>
            <table style="font-size:11px; line-height:1.7; color:var(--muted); width:100%; margin-top:4px;">
              <tr><td>Oppervlakte vlak</td><td style="color:var(--text); text-align:right;">${result.area.toFixed(1)} m²</td></tr>
              <tr><td>Oriëntatie</td><td style="color:var(--text); text-align:right;">${result.azimuthLabel} (${result.azimuthDeg.toFixed(0)}°)</td></tr>
              <tr><td>Dakhelling</td><td style="color:var(--text); text-align:right;">${result.tiltDeg.toFixed(0)}°</td></tr>
              <tr><td>Direct-zon-fractie</td><td style="color:var(--text); text-align:right;">${(result.exposureFraction * 100).toFixed(0)}%</td></tr>
              <tr><td>Rendement (per paneel)</td><td style="color:var(--text); text-align:right;">${fmt(result.actualPerM2)} kWh/m²/jr</td></tr>
              <tr><td>Geschat paneelvermogen</td><td style="color:var(--text); text-align:right;">~${installedKwp.toFixed(1)} kWp</td></tr>
              <tr><td>Installatiekosten</td><td style="color:var(--text); text-align:right;">€&nbsp;${fmt(installCost)} (€${PRICE_PER_WP}/Wp)</td></tr>
            </table>
            <div style="font-size:11px; color:var(--muted); margin-top:8px; line-height:1.5;">
              <strong>Verschil rendement vs. opbrengst:</strong> "kWh/m²/jr" zegt iets over hoe goed één paneel hier presteert (oriëntatie + helling). "kWh/jr totaal" is wat het hele vlak oplevert (m² × rendement). Een klein zuid-dak heeft hoger rendement, een groot west-dak hogere totaal-opbrengst.
            </div>
          </details>

          ${
            top3.length > 0 && rankInTop3 !== 0
              ? `<div style="background:var(--bg); border:1px solid var(--border); border-radius:5px; padding:8px; font-size:11px; color:var(--muted); margin-bottom:8px; line-height:1.5;">
                  <div style="color:var(--text); margin-bottom:4px;"><strong>Top-3 in jouw buurt</strong></div>
                  ${top3
                    .map(
                      (t, i) =>
                        `<div style="display:flex; justify-content:space-between; padding:2px 0; ${t.faceIndex === result.faceIndex ? 'color:var(--accent);' : ''}">
                          <span>#${i + 1} dakvlak ${t.faceIndex} (${t.azimuthLabel}, ${t.area.toFixed(0)}m²)</span>
                          <span>${fmt(t.totalKwhPerYear)} kWh/jr</span>
                        </div>`,
                    )
                    .join('')}
                </div>`
              : ''
          }

          <div style="font-size:11px; color:var(--muted); font-style:italic; margin-bottom:8px;">
            * Ruwe schatting met ~50% diffuus + 50% direct-zon-model. Voor exacte cijfers: offerte + <a href="https://www.zonatlas.nl" target="_blank" style="color:var(--accent-2);">Zonatlas</a>.
          </div>

          <div style="display:flex; flex-direction:column; gap:6px;">
            ${
              !isExcluded && !hasZone
                ? `<div style="background:var(--bg); border:1px solid var(--border); border-radius:5px; padding:8px 10px;">
                    <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:6px;">
                      <span>Bruikbaar deel van dit vlak</span>
                      <span id="pct-value" style="color:var(--accent); font-weight:600;">${usablePct(faceIdx)}%</span>
                    </div>
                    <input id="pct-slider" type="range" min="0" max="100" step="5" value="${usablePct(faceIdx)}" style="width:100%; accent-color: var(--accent);" />
                    <div style="font-size:10px; color:var(--muted); margin-top:4px;">Snel: voor "ongeveer X% bruikbaar". Voor preciezer: teken een zone.</div>
                  </div>`
                : ''
            }
            ${
              !isExcluded
                ? `<button id="draw-zone" style="background:transparent; border:1px solid var(--accent-2); color: var(--accent-2); padding: 6px 10px; border-radius: 4px; font-size: 11px; cursor:pointer; font-weight:600;">
                    📐 Teken paneelzone op dit vlak${hasZone ? ' (extra zone)' : ''}
                  </button>`
                : ''
            }
            ${
              hasZone
                ? `<button id="clear-zones" style="background:transparent; border:1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 4px; font-size: 11px; cursor:pointer;">
                    🗑 Wis paneelzones op dit vlak
                  </button>`
                : ''
            }
            <div style="display:flex; gap:6px;">
              <button id="toggle-exclude" style="background:${isExcluded ? 'var(--accent)' : 'transparent'}; border:1px solid ${isExcluded ? 'var(--accent)' : 'var(--border)'}; color: ${isExcluded ? '#1a1300' : 'var(--text)'}; padding: 6px 10px; border-radius: 4px; font-size: 11px; cursor:pointer; flex:1;">
                ${isExcluded ? '↩ Markeer weer als geschikt' : '✗ Geen panelen mogelijk (riet/anders)'}
              </button>
              <button id="close-info" style="background:transparent; border:1px solid var(--border); color: var(--text); padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor:pointer;">Sluiten</button>
            </div>
          </div>
        `;
        const pctSlider = infoPanel.querySelector<HTMLInputElement>('#pct-slider');
        const pctValue = infoPanel.querySelector<HTMLSpanElement>('#pct-value');
        if (pctSlider && pctValue) {
          // Live label-update tijdens slepen
          pctSlider.addEventListener('input', () => {
            pctValue.textContent = `${pctSlider.value}%`;
          });
          // Bij loslaten: opslaan + samenvatting bijwerken (re-fire is duur, doe alleen op change)
          pctSlider.addEventListener('change', () => {
            const v = Number(pctSlider.value);
            if (v >= 100) roofPct.delete(faceIdx);
            else roofPct.set(faceIdx, v);
            saveRoofPct();
            if (lastPvResults)
              applyPvColors(bag.roofs, bag.roofTriangleToFace, lastPvResults, excludedRoofFaces);
            if (updatePvSummaryRef) updatePvSummaryRef();
            // Re-fire voor de hero-tegels in info-paneel
            const refireEvt = new MouseEvent('click', {
              clientX: e.clientX,
              clientY: e.clientY,
              bubbles: true,
            });
            host.dispatchEvent(refireEvt);
          });
        }

        infoPanel.querySelector<HTMLButtonElement>('#draw-zone')?.addEventListener('click', () => {
          const frame = roofFrames.get(faceIdx);
          if (!frame) return;
          // ringWorld bevat outer-ring vertices (Vector3) van dit dakvlak
          const face = bag.roofFaces.find((f) => f.faceIndex === faceIdx);
          if (!face) return;
          const ringWorld = face.ringWorld.map((p) => ({ x: p.x, y: p.y, z: p.z }));
          roofZoneDrawer.startDrawing(faceIdx, frame, ringWorld);
          infoPanel.hidden = true;
          if (updatePvSummaryRef) updatePvSummaryRef();
        });
        infoPanel.querySelector<HTMLButtonElement>('#clear-zones')?.addEventListener('click', () => {
          roofZoneDrawer.clearFace(faceIdx);
          infoPanel.hidden = true;
          // Re-fire de click op dezelfde positie zodat het paneel meteen opnieuw opent
          const refireEvt = new MouseEvent('click', {
            clientX: e.clientX,
            clientY: e.clientY,
            bubbles: true,
          });
          host.dispatchEvent(refireEvt);
        });
        infoPanel.querySelector<HTMLButtonElement>('#close-info')?.addEventListener('click', () => {
          infoPanel.hidden = true;
        });
        infoPanel.querySelector<HTMLButtonElement>('#toggle-exclude')?.addEventListener('click', () => {
          if (excludedRoofFaces.has(faceIdx)) excludedRoofFaces.delete(faceIdx);
          else excludedRoofFaces.add(faceIdx);
          saveExcluded();
          if (lastPvResults)
            applyPvColors(bag.roofs, bag.roofTriangleToFace, lastPvResults, excludedRoofFaces);
          // Re-trigger the click handler met dezelfde mouse event om panel te ververvansen
          // Simpler: re-roep deze handler. We zetten een synthetic event-trigger via re-fire:
          const btnSummary = document.querySelector<HTMLSpanElement>('#mode-controls .summary');
          // Update summary via een gesimuleerde re-render — eenvoudig door te re-clicken op zelfde positie
          // (we slaan het ook gewoon op + re-renderen panel manueel hieronder)
          infoPanel.hidden = true;
          // Re-fire click via een nieuwe event op dezelfde wereld-positie
          const refireEvt = new MouseEvent('click', {
            clientX: e.clientX,
            clientY: e.clientY,
            bubbles: true,
          });
          host.dispatchEvent(refireEvt);
          // Update mode-control summary
          void btnSummary;
          if (updatePvSummaryRef) updatePvSummaryRef();
        });
        return;
      }

      if (id === 'kas') {
        // Klik → maandgrafiek voor die plek
        const layerToPick = kasLayer.mesh.visible ? kasLayer.mesh : groundLayer.mesh;
        const hits = raycaster.intersectObject(layerToPick, false);
        if (hits.length === 0) return;
        const p = hits[0].point;
        const months = computeMaandGrafiek(p.x, p.y, p.z, buildings.group, undefined, 30);
        const totalSun = months.reduce((s, m) => s + m.sunHours, 0);
        const totalDay = months.reduce((s, m) => s + m.daylightHours, 0);
        const winterMonths = months.filter((m) => [9, 10, 11, 0, 1, 2].includes(m.month));
        const winterAvg = winterMonths.reduce((s, m) => s + m.sunHours, 0) / winterMonths.length;
        infoPanel.hidden = false;
        infoPanel.innerHTML = `
          <h3 style="margin:0 0 8px 0; font-size:14px;">📍 Plek ${p.x.toFixed(1)}m oost, ${(-p.z).toFixed(1)}m noord</h3>
          <div style="font-size:12px; color: var(--muted); margin-bottom: 12px; line-height: 1.5;">
            <strong style="color: var(--text);">Jaar-totaal:</strong>
            <strong style="color: var(--accent);">${totalSun.toFixed(0)}h direct zon</strong> van ${totalDay.toFixed(0)}h daglicht (12 representatieve dagen).<br/>
            <strong style="color: var(--text);">Winter (okt-mrt):</strong>
            <strong style="color: var(--accent);">${winterAvg.toFixed(1)}h zon/dag gemiddeld</strong>
            ${winterAvg < 3 ? '<br/><span style="color:#ff7a30;">⚠️ Onder 3h/dag in de winter — kas-groei stagneert.</span>' : winterAvg < 4 ? '<br/><span style="color:var(--accent);">⚡ Marginaal voor wintergroei.</span>' : '<br/><span style="color:#5fd66e;">✓ Genoeg licht voor wintergroei.</span>'}
          </div>
          <div id="chart-maand" style="height:180px;"></div>
          <button id="close-info" style="margin-top:8px; background:transparent; border:1px solid var(--border); color: var(--text); padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor:pointer;">Sluiten</button>
        `;
        const div = infoPanel.querySelector<HTMLDivElement>('#chart-maand')!;
        if (chartInstance) chartInstance.destroy();
        chartInstance = renderMaandGrafiek(div, 'Direct zon-uren per maand (15e)', months);
        infoPanel.querySelector<HTMLButtonElement>('#close-info')?.addEventListener('click', () => {
          infoPanel.hidden = true;
        });
        return;
      }

      // Terras: klik op heatmap → uurcurve
      const hits = raycaster.intersectObject(eyeLayer.mesh, false);
      if (hits.length === 0) return;

      const p = hits[0].point;
      const summer = new Date(new Date().getFullYear(), 6, 1);
      const lateSummer = new Date(new Date().getFullYear(), 8, 21);
      const cSummer = computeUurCurve(p.x, p.y, p.z, buildings.group, summer, 15);
      const cLate = computeUurCurve(p.x, p.y, p.z, buildings.group, lateSummer, 15);

      const fmtHM = (h: number) =>
        h < 0
          ? '—'
          : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0')}`;

      infoPanel.hidden = false;
      infoPanel.innerHTML = `
        <h3 style="margin:0 0 8px 0; font-size:14px;">📍 Plek ${p.x.toFixed(1)}m oost, ${(-p.z).toFixed(1)}m noord</h3>
        <div style="font-size:12px; color: var(--muted); margin-bottom: 6px; line-height: 1.5;">
          <strong style="color: var(--text);">1 juli</strong> — avondzon (16–22h):
          <strong style="color: var(--accent);">${cSummer.avondZonHours.toFixed(1)}h</strong>,
          laatste zon tot <strong style="color: var(--accent);">${fmtHM(cSummer.lastSunHour)}</strong><br/>
          <span style="opacity:0.7;">hele dag: ${cSummer.sunHours.toFixed(1)}h van ${cSummer.totalHours.toFixed(1)}h daglicht</span>
        </div>
        <div style="font-size:12px; color: var(--muted); margin-bottom: 12px; line-height: 1.5;">
          <strong style="color: var(--text);">21 sept</strong> — avondzon (16–22h):
          <strong style="color: var(--accent);">${cLate.avondZonHours.toFixed(1)}h</strong>,
          laatste zon tot <strong style="color: var(--accent);">${fmtHM(cLate.lastSunHour)}</strong><br/>
          <span style="opacity:0.7;">hele dag: ${cLate.sunHours.toFixed(1)}h van ${cLate.totalHours.toFixed(1)}h daglicht</span>
        </div>
        <div id="chart-summer" style="height:100px; margin-bottom:8px;"></div>
        <div id="chart-late" style="height:100px;"></div>
        <button id="close-info" style="margin-top:8px; background:transparent; border:1px solid var(--border); color: var(--text); padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor:pointer;">Sluiten</button>
      `;
      const sumDiv = infoPanel.querySelector<HTMLDivElement>('#chart-summer')!;
      const lateDiv = infoPanel.querySelector<HTMLDivElement>('#chart-late')!;
      if (chartInstance) chartInstance.destroy();
      renderUurCurve(sumDiv, '1 juli', cSummer.curve);
      chartInstance = renderUurCurve(lateDiv, '21 september', cLate.curve);

      infoPanel.querySelector<HTMLButtonElement>('#close-info')?.addEventListener('click', () => {
        infoPanel.hidden = true;
      });
    });

    // Camera op huis
    root.controls.target.set(0, 4, 0);
    root.camera.position.set(40, 30, 40);
    root.controls.update();

    // Forceer zon-update
    sun.setDate(timeStrip.current());

    console.log(
      `[BAG] ${bag.buildingCount} features, ${bag.roofFaces.length} dakvlakken, maaiveld NAP +${bag.groundLevelNap.toFixed(2)}m`,
    );
    setLoading(null);

    // expose voor debugging
    (window as any).THREE = THREE;
    (window as any).zon = {
      accumulator,
      kasAccumulator,
      eyeLayer,
      kasLayer,
      sun,
      buildings,
      bag,
      root,
      terrasZomerDag,
      polyDrawer,
      bestSpotPin,
      roofZoneDrawer,
      roofFrames,
      get lastPvResults() {
        return lastPvResults;
      },
    };
  } catch (err) {
    console.error(err);
    setLoading(`Fout bij laden: ${err instanceof Error ? err.message : String(err)}`);
  }
})();
