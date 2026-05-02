import * as THREE from 'three';
import SunCalc from 'suncalc';
import { HOUSE } from '../config';

export interface SunSample {
  azimuthDeg: number; // 0=noord, 90=oost, 180=zuid, 270=west (BAG-conventie)
  altitudeDeg: number; // 0=horizon, 90=zenith
  /** Eenheidsvector in lokale scene-coords (X=oost, Y=omhoog, Z=zuid). */
  direction: THREE.Vector3;
  /** True als zon onder de horizon staat. */
  belowHorizon: boolean;
}

/**
 * Bereken zonpositie voor een datum + tijd op het huiscoördinaat.
 * SunCalc-conventie: azimuth 0 = zuid, π/2 = west.
 * We converteren naar de "noord = 0"-conventie en naar een 3D-richting.
 */
export function getSun(date: Date): SunSample {
  const p = SunCalc.getPosition(date, HOUSE.wgs84.lat, HOUSE.wgs84.lon);
  // SunCalc: azimuth 0=zuid, +π/2=west. Voor noord-conventie: +180.
  const azNorthRad = p.azimuth + Math.PI;
  const altRad = p.altitude;

  // Lokale coords: X=oost, Y=omhoog, Z=zuid (positief).
  // Eenheidsvector richting de zon (vanuit oorsprong):
  //   horizontal = sin(az_from_north) → X (oost)
  //                cos(az_from_north) → -Z (noord)  ⇒  +Z = zuid, dus -cos
  //   vertical   = sin(alt) → Y
  const dir = new THREE.Vector3(
    Math.sin(azNorthRad) * Math.cos(altRad),
    Math.sin(altRad),
    -Math.cos(azNorthRad) * Math.cos(altRad),
  );

  return {
    azimuthDeg: ((azNorthRad * 180) / Math.PI + 360) % 360,
    altitudeDeg: (altRad * 180) / Math.PI,
    direction: dir.normalize(),
    belowHorizon: altRad <= 0,
  };
}

export interface DaySunRange {
  sunrise: Date;
  sunset: Date;
  solarNoon: Date;
}

export function getDayRange(date: Date): DaySunRange {
  const t = SunCalc.getTimes(date, HOUSE.wgs84.lat, HOUSE.wgs84.lon);
  return { sunrise: t.sunrise, sunset: t.sunset, solarNoon: t.solarNoon };
}
