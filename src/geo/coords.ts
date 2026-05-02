import proj4 from 'proj4';
import { HOUSE } from '../config';

// Rijksdriehoekstelsel (EPSG:28992) — Nederlandse standaard.
// Standaard string van epsg.io/28992. Officiële parameters incl. towgs84-shift.
proj4.defs(
  'EPSG:28992',
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 ' +
    '+k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel ' +
    '+towgs84=565.7381,50.4018,465.2904,-0.39878,0.343989,-1.87705,4.0725 +units=m +no_defs',
);

const RD = 'EPSG:28992';
const WGS = 'WGS84';

/** WGS84 (lon, lat) → RD New (x, y) in meters. */
export function wgsToRd(lon: number, lat: number): [number, number] {
  return proj4(WGS, RD, [lon, lat]) as [number, number];
}

/** RD New (x, y) in meters → WGS84 (lon, lat). */
export function rdToWgs(x: number, y: number): [number, number] {
  return proj4(RD, WGS, [x, y]) as [number, number];
}

/**
 * RD-meters (x, y) + NAP-hoogte z → lokale three.js coördinaten (X, Y, Z) in meters.
 * Origin = huis. three.js Y is omhoog. Z negatief = noord (zodat zon vanuit zuid +Z licht).
 */
export function rdToLocal(x: number, y: number, z: number = 0): [number, number, number] {
  return [x - HOUSE.rd.x, z, -(y - HOUSE.rd.y)];
}

/** Inverse van rdToLocal. */
export function localToRd(localX: number, localY: number, localZ: number): [number, number, number] {
  return [localX + HOUSE.rd.x, -(localZ) + HOUSE.rd.y, localY];
}

/**
 * Bbox helper: RD-bbox rondom huis, in meters.
 * Result: [minX, minY, maxX, maxY]
 */
export function houseBbox(radiusM: number): [number, number, number, number] {
  return [
    HOUSE.rd.x - radiusM,
    HOUSE.rd.y - radiusM,
    HOUSE.rd.x + radiusM,
    HOUSE.rd.y + radiusM,
  ];
}
