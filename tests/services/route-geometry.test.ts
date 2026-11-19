/**
 * @fileoverview Tests for the route-search geometry: Google polyline encoding, each point's position
 * along and off a route (checked against hand-computed spherical right-triangle values), and the
 * buffer Open Charge Map has to draw to cover a corridor, with its pole and ±180° bound.
 * @module tests/services/route-geometry.test
 */

import { describe, expect, it } from 'vitest';
import {
  corridorBuffer,
  encodePolyline,
  routeGeometry,
} from '@/services/openchargemap/route-geometry.js';
import { SEATTLE_PORTLAND_ROUTE } from '../fixtures/ocm.js';
import { type LatLng, uncoveredPoints } from '../fixtures/ocm-corridor.js';

const RAD = Math.PI / 180;
/** Radians per km on the 6,371 km sphere Open Charge Map reports distances on. */
const PER_KM = 1 / 6371;

const route = (...points: [number, number][]) =>
  points.map(([latitude, longitude]) => ({ latitude, longitude }));

describe('encodePolyline', () => {
  it("encodes Google's reference polyline", () => {
    expect(encodePolyline(route([38.5, -120.2], [40.7, -120.95], [43.252, -126.453]))).toBe(
      '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    );
  });

  it('encodes the Seattle–Portland waypoints at 1e5 precision', () => {
    // Encoded independently with a separate implementation of the algorithm.
    expect(encodePolyline(SEATTLE_PORTLAND_ROUTE)).toBe('waqaHr~siVz~mBv`nBbvnDjiFvtxBwvq@');
  });
});

describe('routeGeometry', () => {
  it('measures a point beside an equatorial leg by its perpendicular', () => {
    const g = routeGeometry(route([0, 0], [0, 1]));
    const p = g.locate(0.1, 0.5);

    expect(g.length).toBeCloseTo(1 * RAD, 12);
    expect(p.along).toBeCloseTo(0.5 * RAD, 12);
    expect(p.off).toBeCloseTo(0.1 * RAD, 12);
  });

  it('measures a point beside a meridian leg with the right-triangle formulas', () => {
    const p = routeGeometry(route([0, 10], [2, 10])).locate(1, 10.5);

    // Napier: sin(off) = cos φ · sin Δλ; tan(foot latitude) = tan φ / cos Δλ.
    expect(p.off).toBeCloseTo(Math.asin(Math.cos(1 * RAD) * Math.sin(0.5 * RAD)), 12);
    expect(p.along).toBeCloseTo(Math.atan(Math.tan(1 * RAD) / Math.cos(0.5 * RAD)), 12);
  });

  it('measures a point before the start or past the end from that endpoint', () => {
    const g = routeGeometry(route([0, 0], [0, 1]));

    expect(g.locate(0, -0.2)).toMatchObject({ along: 0 });
    expect(g.locate(0, -0.2).off).toBeCloseTo(0.2 * RAD, 12);
    expect(g.locate(0, 1.4).along).toBeCloseTo(1 * RAD, 12);
    expect(g.locate(0, 1.4).off).toBeCloseTo(0.4 * RAD, 12);
  });

  it('adds the earlier legs to the along-route distance after a turn', () => {
    const p = routeGeometry(route([0, 0], [0, 1], [1, 1])).locate(0.5, 1.2);

    expect(p.off).toBeCloseTo(Math.asin(Math.cos(0.5 * RAD) * Math.sin(0.2 * RAD)), 12);
    expect(p.along).toBeCloseTo(1 * RAD + Math.atan(Math.tan(0.5 * RAD) / Math.cos(0.2 * RAD)), 12);
  });

  it('places a point on a route that doubles back at its earliest nearest point', () => {
    const g = routeGeometry(route([0, 0], [0, 1], [0, 0]));
    const p = g.locate(0.1, 0.5);

    expect(g.length).toBeCloseTo(2 * RAD, 12);
    // The second leg passes the same point at 1.5°; the tie goes to the first.
    expect(p.along).toBeCloseTo(0.5 * RAD, 12);
    expect(p.off).toBeCloseTo(0.1 * RAD, 12);
  });

  it('treats a repeated point as a zero-length leg', () => {
    const g = routeGeometry(route([0, 0], [0, 0], [0, 1]));
    const p = g.locate(0.1, 0.5);

    expect(g.length).toBeCloseTo(1 * RAD, 12);
    expect(p.along).toBeCloseTo(0.5 * RAD, 12);
    expect(p.off).toBeCloseTo(0.1 * RAD, 12);
  });

  it('places the pole of a leg, equidistant from all of it, at the leg start', () => {
    const p = routeGeometry(route([0, 0], [0, 1])).locate(90, 0);

    expect(p.along).toBe(0);
    expect(p.off).toBeCloseTo(90 * RAD, 12);
  });
});

describe('corridorBuffer', () => {
  it('widens a 5 km Seattle–Portland corridor past the bare east–west requirement', () => {
    const buffer = corridorBuffer(SEATTLE_PORTLAND_ROUTE, 5 * PER_KM);

    expect(buffer).toHaveProperty('degrees');
    const km = 200 * (buffer as { degrees: number }).degrees;
    // 13.35 km is 5 km of longitude at 47.65° N, before any margin. The margins on top: a corner chord
    // of a four-point route cuts inside by cos(3π/32), and the 0.001° simplification is 0.2 km more.
    expect(km).toBeGreaterThan(13.35);
    expect(km).toBeLessThan(13.36 / Math.cos((3 * Math.PI) / 32) + 0.21);
  });

  it('needs a wider buffer at a higher latitude, and with fewer points to round its caps', () => {
    const at = (latitude: number, points: number) =>
      corridorBuffer(
        Array.from({ length: points }, (_, i) => ({
          latitude,
          longitude: (i / (points - 1)) * 0.5,
        })),
        5 * PER_KM,
      ) as { degrees: number };

    expect(at(60, 2).degrees).toBeGreaterThan(at(30, 2).degrees);
    expect(at(45, 2).degrees).toBeGreaterThan(at(45, 50).degrees);
  });

  it('fits the 500 km maximum around a mid-latitude route', () => {
    expect(corridorBuffer(SEATTLE_PORTLAND_ROUTE, 500 * PER_KM)).toHaveProperty('degrees');
  });

  it.each([
    // Svalbard: 11.08° from the pole. The south of New Zealand: 1.63° from ±180°.
    ['near a pole', route([78.22, 15.65], [78.92, 11.93]), 90 - 78.92],
    ['near ±180°', route([-37.9, 178], [-37.63, 178.37]), 180 - 178.37],
  ])('names the widest corridor that fits a route %s', (_label, points, room) => {
    const refused = corridorBuffer(points, 200 * PER_KM);

    expect(refused).toHaveProperty('widest');
    const { widest } = refused as { widest: number };
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThan(200 * PER_KM);
    const fitted = corridorBuffer(points, widest);
    expect(fitted).toHaveProperty('degrees');
    expect((fitted as { degrees: number }).degrees).toBeLessThanOrEqual(room);
    expect(corridorBuffer(points, widest * 1.001)).toHaveProperty('widest');
  });

  it('fits no corridor around a point on ±180°', () => {
    expect(corridorBuffer(route([-16.5, 179.5], [-16.8, 180]), 1 * PER_KM)).toEqual({
      widest: 0,
    });
  });

  /**
   * The property the buffer exists for: every point within the half-width of the route lies inside
   * the corridor polygon Open Charge Map draws from it, rebuilt independently of the code under test
   * (`tests/fixtures/ocm-corridor.ts`) and sampled at 0.999 of the half-width.
   */
  describe('keeps every point within the half-width inside the corridor Open Charge Map draws', () => {
    const uncovered = (points: LatLng[], km: number) => {
      const buffer = corridorBuffer(points, km * PER_KM);
      if (!('degrees' in buffer)) throw new Error(`Expected a ${km} km corridor to fit the route.`);
      return uncoveredPoints(points, km * PER_KM, buffer.degrees);
    };

    it.each([
      ['Seattle → Portland, 5 km', SEATTLE_PORTLAND_ROUTE, 5],
      ['Seattle → Portland, 0.1 km', SEATTLE_PORTLAND_ROUTE, 0.1],
      ['Tromsø → Alta, two points, 15 km', route([69.65, 18.96], [69.97, 23.27]), 15],
      [
        'east to west along I-90, 10 km',
        route(
          [47.61, -122.33],
          [46.99, -120.55],
          [47.66, -117.43],
          [46.87, -114.0],
          [46.0, -112.53],
          [45.78, -108.5],
          [43.54, -96.73],
          [41.88, -87.63],
        ),
        10,
      ],
      ['doubling back, 2 km', route([47.6, -122.33], [47.25, -122.44], [47.6, -122.33]), 2],
      [
        'turning 40° at its middle point, 10 km',
        route([45.5905, 10.513], [47, 10], [47.0188, 10.0068]),
        10,
      ],
    ])('%s', (_label, points, km) => {
      expect(uncovered(points, km)).toEqual([]);
    });

    it('over 100 seeded random routes', () => {
      let state = 20_261_119;
      const random = () => {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        return state / 2 ** 32;
      };
      const failures: { route: number; km: number; points: number; uncovered: number }[] = [];
      for (let r = 0; r < 100; r++) {
        // 2–13 points, legs of 1–151 km that wander, anywhere within 72° of the equator.
        let latitude = random() * 140 - 70;
        let longitude = random() * 300 - 150;
        let bearing = random() * 2 * Math.PI;
        const points = [{ latitude, longitude }];
        for (let n = 1 + Math.floor(random() * 12); n > 0; n--) {
          const step = (1 + random() * 150) / 111.2;
          bearing += (random() - 0.5) * 2.5;
          latitude = Math.max(-72, Math.min(72, latitude + step * Math.cos(bearing)));
          longitude += (step * Math.sin(bearing)) / Math.cos(latitude * RAD);
          points.push({ latitude, longitude });
        }
        const km = random() < 0.3 ? 0.05 + random() * 0.5 : 0.5 + random() * 40;
        const buffer = corridorBuffer(points, km * PER_KM);
        if (!('degrees' in buffer)) continue;
        const missed = uncoveredPoints(points, km * PER_KM, buffer.degrees).length;
        if (missed > 0) failures.push({ route: r, km, points: points.length, uncovered: missed });
      }
      expect(failures).toEqual([]);
    });
  });
});
