import * as THREE from 'three';
import { houseBbox } from './coords';

export type TopoVariant = 'pastel' | 'grijs';

interface BackgroundOptions {
  radiusM: number;
  pixelSize: number;
  variant: TopoVariant;
  withKadaster: boolean;
}

// PDOK WMTS RD-grid (EPSG:28992) — resoluties = ScaleDenominator × 0.00028
const RD_WMTS = {
  originX: -285401.92,
  originY: 903401.92,
  tilePx: 256,
  // m/pixel per zoom-level (uit WMTSCapabilities)
  res: { 9: 6.72, 10: 3.36, 11: 1.68, 12: 0.84, 13: 0.42, 14: 0.21 } as Record<number, number>,
};

/**
 * Haalt een topografische achtergrond-textuur op (BRT-A WMTS, RD-coords).
 * Stitched meerdere tegels samen tot één canvas, met optionele kadasterlijnen-overlay.
 *
 * BRT-A is afgeleid uit BAG/BGT, dus 1:1 aligned met onze 3D-gebouwen.
 */
export async function fetchTopoBackground(opts: BackgroundOptions): Promise<{
  texture: THREE.Texture;
  bbox: [number, number, number, number];
  sizeM: number;
}> {
  const bbox = houseBbox(opts.radiusM);
  const sizeM = opts.radiusM * 2;

  // Kies zoom: 200m → 13 (0.42 m/px ≈ 480 px native), 400m+ → 12
  const zoom = sizeM <= 250 ? 13 : 12;
  const zoomStr = String(zoom).padStart(2, '0');
  const res = RD_WMTS.res[zoom];
  const tileSpan = RD_WMTS.tilePx * res;

  // Tile range
  const colMin = Math.floor((bbox[0] - RD_WMTS.originX) / tileSpan);
  const colMax = Math.floor((bbox[2] - RD_WMTS.originX) / tileSpan);
  const rowMin = Math.floor((RD_WMTS.originY - bbox[3]) / tileSpan); // Y inverted
  const rowMax = Math.floor((RD_WMTS.originY - bbox[1]) / tileSpan);
  const cols = colMax - colMin + 1;
  const rows = rowMax - rowMin + 1;

  // Fetch alle tegels parallel
  const tilePromises: Promise<{ img: ImageBitmap; col: number; row: number }>[] = [];
  for (let c = colMin; c <= colMax; c++) {
    for (let r = rowMin; r <= rowMax; r++) {
      const url = `/api/pdok-brt/${opts.variant}/EPSG:28992/${zoomStr}/${r}/${c}.png`;
      tilePromises.push(
        fetch(url)
          .then((res) => {
            if (!res.ok) throw new Error(`BRT tile ${zoomStr}/${r}/${c}: ${res.status}`);
            return res.blob();
          })
          .then((b) => createImageBitmap(b))
          .then((img) => ({ img, col: c, row: r })),
      );
    }
  }
  const tiles = await Promise.all(tilePromises);

  // Stitch alle tegels naar een groot canvas
  const stitchedW = cols * RD_WMTS.tilePx;
  const stitchedH = rows * RD_WMTS.tilePx;
  const stitched = document.createElement('canvas');
  stitched.width = stitchedW;
  stitched.height = stitchedH;
  const sCtx = stitched.getContext('2d')!;
  for (const t of tiles) {
    const dx = (t.col - colMin) * RD_WMTS.tilePx;
    const dy = (t.row - rowMin) * RD_WMTS.tilePx;
    sCtx.drawImage(t.img, dx, dy);
  }

  // Crop naar de gewenste bbox + resize naar pixelSize
  const tileBboxMinX = colMin * tileSpan + RD_WMTS.originX;
  const tileBboxMaxY = RD_WMTS.originY - rowMin * tileSpan;
  const cropX = (bbox[0] - tileBboxMinX) / res;
  const cropY = (tileBboxMaxY - bbox[3]) / res;
  const cropW = (bbox[2] - bbox[0]) / res;
  const cropH = (bbox[3] - bbox[1]) / res;

  const out = document.createElement('canvas');
  out.width = opts.pixelSize;
  out.height = opts.pixelSize;
  const oCtx = out.getContext('2d')!;
  oCtx.drawImage(stitched, cropX, cropY, cropW, cropH, 0, 0, opts.pixelSize, opts.pixelSize);

  // Kadasterlijnen-overlay (transparant WMS GetMap voor exact dezelfde bbox)
  if (opts.withKadaster) {
    try {
      const params = new URLSearchParams({
        service: 'WMS',
        request: 'GetMap',
        version: '1.1.1',
        layers: 'Perceel',
        srs: 'EPSG:28992',
        bbox: bbox.join(','),
        width: String(opts.pixelSize),
        height: String(opts.pixelSize),
        format: 'image/png',
        styles: '',
        transparent: 'true',
      });
      const blob = await fetch(`/api/pdok-kadaster-wms?${params}`).then((r) => {
        if (!r.ok) throw new Error(`Kadaster WMS ${r.status}`);
        return r.blob();
      });
      const bmp = await createImageBitmap(blob);
      oCtx.drawImage(bmp, 0, 0, opts.pixelSize, opts.pixelSize);
    } catch (err) {
      console.warn('Kadasterlijnen-overlay mislukt, alleen topo getoond:', err);
    }
  }

  const texture = new THREE.CanvasTexture(out);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  return { texture, bbox, sizeM };
}

/** Backwards-compat alias (heet nog 'aerial' in main.ts). */
export const fetchAerialTexture = (opts: { radiusM: number; pixelSize: number }) =>
  fetchTopoBackground({ ...opts, variant: 'pastel', withKadaster: false });
