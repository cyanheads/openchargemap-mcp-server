/**
 * @fileoverview Tests for the bounding-box geometry behind find_stations: the circle `boxCircle`
 * draws around a box holds every point of the box and reaches no farther than the box does, and
 * `boxContains` reads crossing boxes, either latitude order, ±180°, and the edges themselves. Angles
 * are checked against an independent 3-D vector computation, not the module's own angle formula.
 * @module tests/services/search-geometry.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { boxCircle, boxContains } from '@/services/openchargemap/search-geometry.js';
import type { BoundingBox } from '@/services/openchargemap/types.js';

const RADIANS_PER_DEGREE = Math.PI / 180;

type Vector = readonly [number, number, number];

/** The unit vector of a latitude/longitude in degrees. */
function unitVector(latitude: number, longitude: number): Vector {
  const phi = latitude * RADIANS_PER_DEGREE;
  const lambda = longitude * RADIANS_PER_DEGREE;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

/**
 * Great-circle angle between two unit vectors from their dot and cross products. `atan2` keeps it
 * accurate at every angle, where `acos` of the dot product alone loses half its digits near 0 and π.
 */
function angleBetween(a: Vector, b: Vector): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = Math.hypot(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
  return Math.atan2(cross, dot);
}

/** A longitude folded into [-180, 180]. */
function wrap(longitude: number): number {
  return longitude > 180 ? longitude - 360 : longitude;
}

/**
 * A box built from its west edge and an eastward width, kept beside the span the tool's contract
 * gives its corners — east from `sw_lng` to `ne_lng`, across ±180° when `sw_lng > ne_lng` — so
 * sample points come from that contract rather than from the module under test. Latitudes arrive in
 * either order.
 */
interface GeneratedBox {
  box: BoundingBox;
  north: number;
  south: number;
  west: number;
  width: number;
}

function generatedBox(first: number, second: number, west: number, width: number): GeneratedBox {
  const east = wrap(west + width);
  return {
    box: { sw_lat: first, sw_lng: west, ne_lat: second, ne_lng: east },
    north: Math.max(first, second),
    south: Math.min(first, second),
    west,
    // Rounding can fold a width a hair under 360° onto the west edge, which the contract reads as 0°.
    width: east >= west ? east - west : east - west + 360,
  };
}

const latitude = fc.oneof(
  fc.double({ min: -90, max: 90, noNaN: true }),
  fc.double({ min: 80, max: 90, noNaN: true }),
  fc.double({ min: -90, max: -80, noNaN: true }),
);

/**
 * Boxes of every shape the tool accepts: either latitude order, crossing ±180° or not, widths from
 * zero up to (but not including) 360° from any west edge, near-pole boxes, and the full 360° box,
 * which only `sw_lng` -180 / `ne_lng` 180 can express.
 */
const boxes = fc
  .oneof(
    {
      weight: 8,
      arbitrary: fc.tuple(
        latitude,
        latitude,
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: 0, max: 360, maxExcluded: true, noNaN: true }),
      ),
    },
    { weight: 1, arbitrary: fc.tuple(latitude, latitude, fc.constant(-180), fc.constant(360)) },
  )
  .map(([first, second, west, width]) => generatedBox(first, second, west, width));

/** Fractions `[u, t]` that place extra points inside a box. */
const interiorFractions = fc.array(
  fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })),
  { maxLength: 16 },
);

/**
 * The point a fraction `u` of the way from south to north and `t` of the way east across the box.
 * Interpolation can round a hair past the north or east edge; the edge bounds it, since a sample
 * outside the box would test nothing about the box.
 */
function pointAt(g: GeneratedBox, u: number, t: number): [number, number] {
  const lat = u === 1 ? g.north : Math.min(g.north, g.south + u * (g.north - g.south));
  if (t === 1) return [lat, g.box.ne_lng];
  const east = g.box.ne_lng;
  const raw = g.west + t * g.width;
  if (g.box.sw_lng <= east) return [lat, Math.min(raw, east)];
  return [lat, raw > 180 ? Math.min(raw - 360, east) : raw];
}

const STEPS = 32;
const FRACTIONS = Array.from({ length: STEPS + 1 }, (_, i) => i / STEPS);

/** Points on all four edges, corners included. */
function boundarySamples(g: GeneratedBox): [number, number][] {
  return FRACTIONS.flatMap((f) => [
    pointAt(g, 0, f),
    pointAt(g, 1, f),
    pointAt(g, f, 0),
    pointAt(g, f, 1),
  ]);
}

/**
 * The largest angle from `center` along one meridian edge, found by ternary search over latitude
 * with both ends kept as candidates. Along a meridian the angle has at most one interior turning
 * point, so the search lands on it when it is a maximum and the ends cover every other case.
 */
function edgeMaximum(g: GeneratedBox, t: 0 | 1, center: Vector): number {
  const at = (u: number) => angleBetween(center, unitVector(...pointAt(g, u, t)));
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 100; step += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (at(m1) < at(m2)) lo = m1;
    else hi = m2;
  }
  return Math.max(at(0), at(1), at((lo + hi) / 2));
}

/** Interior grid fractions, a few per axis, well clear of the edges. */
const GRID = FRACTIONS.filter((_, i) => i % 4 === 2);

/**
 * The circle `boxCircle` draws for a generated box: centered on the box's midpoint, holding every
 * sampled point of the box, and reaching exactly as far as the box's farthest point.
 */
function checkCircle(g: GeneratedBox, interior: [number, number][]): void {
  const circle = boxCircle(g.box);

  // The center is the box's own midpoint — across ±180° when the box spans it.
  expect(circle.crossesAntimeridian).toBe(g.box.sw_lng > g.box.ne_lng);
  expect(circle.latitude).toBeCloseTo((g.north + g.south) / 2, 9);
  const lngOffset = ((((circle.longitude - (g.west + g.width / 2)) % 360) + 540) % 360) - 180;
  expect(Math.abs(lngOffset)).toBeLessThan(1e-9);

  const center = unitVector(circle.latitude, circle.longitude);
  const angleTo = ([lat, lng]: [number, number]) => angleBetween(center, unitVector(lat, lng));
  const points = [
    ...boundarySamples(g),
    ...GRID.flatMap((u) => GRID.map((t) => pointAt(g, u, t))),
    ...interior.map(([u, t]) => pointAt(g, u, t)),
  ];
  expect(points.filter(([lat, lng]) => !boxContains(g.box, lat, lng))).toEqual([]);
  expect(Math.max(...points.map(angleTo))).toBeLessThanOrEqual(circle.farthestAngle + 1e-9);

  // Some point of the box sits at the circle's edge: the radius is no larger than it must be.
  const attained = Math.max(
    ...boundarySamples(g).map(angleTo),
    edgeMaximum(g, 0, center),
    edgeMaximum(g, 1, center),
  );
  expect(Math.abs(attained - circle.farthestAngle)).toBeLessThan(1e-9);
}

describe('boxCircle', () => {
  it('draws a circle around the box center that holds every point of the box and reaches its farthest point', () => {
    fc.assert(fc.property(boxes, interiorFractions, checkCircle), { numRuns: 2000 });
  });

  it('centers the Kamchatka–Alaska box at 57, -176.25 and reads it as crossing ±180°', () => {
    const circle = boxCircle({ sw_lat: 52.5, sw_lng: 158, ne_lat: 61.5, ne_lng: -150.5 });
    expect(circle).toMatchObject({ crossesAntimeridian: true, latitude: 57, longitude: -176.25 });
  });

  it('reaches past the corners to the middle of the east edge of a box wider than 180°', () => {
    // 340° wide on the equator: the edge midpoints sit 170° from the center, the corners less.
    const circle = boxCircle({ sw_lat: -10, sw_lng: -170, ne_lat: 10, ne_lng: 170 });
    expect(circle.farthestAngle).toBeCloseTo(170 * RADIANS_PER_DEGREE, 12);
    const corner = angleBetween(unitVector(0, 0), unitVector(10, 170));
    expect(circle.farthestAngle).toBeGreaterThan(corner);
  });
});

describe('boxContains', () => {
  const crossing: BoundingBox = { sw_lat: -10, sw_lng: 170, ne_lat: 10, ne_lng: -170 };

  it('holds the 20° around ±180° for a crossing box, not the 340° between its edges', () => {
    for (const lng of [170, 175, 180, -180, -175, -170])
      expect(boxContains(crossing, 0, lng)).toBe(true);
    for (const lng of [169.999, 0, -169.999, 90]) expect(boxContains(crossing, 0, lng)).toBe(false);
  });

  it('reads -180° and 180° as the same meridian', () => {
    expect(boxContains({ sw_lat: 0, sw_lng: 170, ne_lat: 10, ne_lng: 180 }, 5, -180)).toBe(true);
    expect(boxContains({ sw_lat: 0, sw_lng: -180, ne_lat: 10, ne_lng: -170 }, 5, 180)).toBe(true);
    expect(boxContains({ sw_lat: 0, sw_lng: -170, ne_lat: 10, ne_lng: 170 }, 5, 180)).toBe(false);
  });

  it('includes every edge and corner and excludes points just past them', () => {
    const box: BoundingBox = { sw_lat: 47.4, sw_lng: -122.5, ne_lat: 47.8, ne_lng: -122.1 };
    for (const [lat, lng] of [
      [47.4, -122.5],
      [47.8, -122.1],
      [47.4, -122.1],
      [47.8, -122.5],
      [47.6, -122.5],
      [47.8, -122.3],
    ] as const) {
      expect(boxContains(box, lat, lng)).toBe(true);
    }
    for (const [lat, lng] of [
      [47.399_999, -122.3],
      [47.800_001, -122.3],
      [47.6, -122.500_001],
      [47.6, -122.099_999],
    ] as const) {
      expect(boxContains(box, lat, lng)).toBe(false);
    }
  });

  it('reads swapped latitude corners as the same box', () => {
    const ordered: BoundingBox = { sw_lat: 47.4, sw_lng: -122.5, ne_lat: 47.8, ne_lng: -122.1 };
    const swapped: BoundingBox = { ...ordered, sw_lat: 47.8, ne_lat: 47.4 };
    for (const lat of [47.399, 47.4, 47.6, 47.8, 47.801]) {
      expect(boxContains(swapped, lat, -122.3)).toBe(boxContains(ordered, lat, -122.3));
    }
    expect(boxContains(swapped, 47.6, -122.3)).toBe(true);
    expect(boxContains(swapped, 47.9, -122.3)).toBe(false);
  });
});
