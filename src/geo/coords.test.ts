import { describe, expect, it } from 'vitest';
import { HOUSE } from '../config';
import { houseBbox, localToRd, rdToLocal, rdToWgs, wgsToRd } from './coords';

describe('coord transforms', () => {
  it('WGS huiscoördinaat → RD geeft de bekende RD-coördinaten ±2m', () => {
    const [x, y] = wgsToRd(HOUSE.wgs84.lon, HOUSE.wgs84.lat);
    expect(x).toBeCloseTo(HOUSE.rd.x, -1); // tolerantie ~5m bij precision -1
    expect(y).toBeCloseTo(HOUSE.rd.y, -1);
    expect(Math.abs(x - HOUSE.rd.x)).toBeLessThan(2);
    expect(Math.abs(y - HOUSE.rd.y)).toBeLessThan(2);
  });

  it('RD → WGS → RD is identiteit binnen sub-meter', () => {
    const [lon, lat] = rdToWgs(HOUSE.rd.x, HOUSE.rd.y);
    const [x2, y2] = wgsToRd(lon, lat);
    expect(Math.abs(x2 - HOUSE.rd.x)).toBeLessThan(0.001);
    expect(Math.abs(y2 - HOUSE.rd.y)).toBeLessThan(0.001);
  });

  it('rdToLocal van het huis zelf is (0, 0, 0)', () => {
    const [x, y, z] = rdToLocal(HOUSE.rd.x, HOUSE.rd.y, 0);
    expect(x).toBe(0);
    expect(y).toBe(0);
    expect(Math.abs(z)).toBe(0);
  });

  it('rdToLocal → localToRd is identiteit', () => {
    const rdX = HOUSE.rd.x + 12.34;
    const rdY = HOUSE.rd.y - 5.67;
    const napZ = 8.5;
    const [lx, ly, lz] = rdToLocal(rdX, rdY, napZ);
    const [rx, ry, rz] = localToRd(lx, ly, lz);
    expect(rx).toBeCloseTo(rdX, 6);
    expect(ry).toBeCloseTo(rdY, 6);
    expect(rz).toBeCloseTo(napZ, 6);
  });

  it('Een punt 10m noordelijker (RD-y +10) heeft lokale Z = -10', () => {
    const [, , localZ] = rdToLocal(HOUSE.rd.x, HOUSE.rd.y + 10, 0);
    expect(localZ).toBe(-10);
  });

  it('Een punt 10m oostelijker (RD-x +10) heeft lokale X = +10', () => {
    const [localX] = rdToLocal(HOUSE.rd.x + 10, HOUSE.rd.y, 0);
    expect(localX).toBe(10);
  });

  it('houseBbox geeft een symmetrische bbox rond huis', () => {
    const [minX, minY, maxX, maxY] = houseBbox(60);
    expect(maxX - minX).toBe(120);
    expect(maxY - minY).toBe(120);
    expect((minX + maxX) / 2).toBe(HOUSE.rd.x);
    expect((minY + maxY) / 2).toBe(HOUSE.rd.y);
  });
});
