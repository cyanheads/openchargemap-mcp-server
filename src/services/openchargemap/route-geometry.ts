/**
 * @fileoverview Route geometry for corridor searches: the Google encoded polyline Open Charge Map
 * reads, the buffer it has to draw around that polyline to cover a corridor, and each station's
 * position along and off the route. Angles are radians on a unit sphere, so each caller scales them
 * by whichever Earth radius its metric uses.
 * @module services/openchargemap/route-geometry
 */

import type { RoutePoint } from './types.js';

const RADIANS_PER_DEGREE = Math.PI / 180;

/** Encode one signed integer delta of a Google encoded polyline. */
function encodeDelta(delta: number): string {
  let value = delta < 0 ? ~(delta << 1) : delta << 1;
  let out = '';
  while (value >= 0x20) {
    out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  return out + String.fromCharCode(value + 63);
}

/**
 * Encode a route as a Google encoded polyline at 1e5 precision, the precision Open Charge Map
 * decodes (a 1e6 encoding comes back as an empty body).
 */
export function encodePolyline(points: readonly RoutePoint[]): string {
  let out = '';
  let latitude = 0;
  let longitude = 0;
  for (const point of points) {
    const nextLatitude = Math.round(point.latitude * 1e5);
    const nextLongitude = Math.round(point.longitude * 1e5);
    out += encodeDelta(nextLatitude - latitude) + encodeDelta(nextLongitude - longitude);
    latitude = nextLatitude;
    longitude = nextLongitude;
  }
  return out;
}

type Vector = readonly [number, number, number];

function toVector(latitude: number, longitude: number): Vector {
  const phi = latitude * RADIANS_PER_DEGREE;
  const lambda = longitude * RADIANS_PER_DEGREE;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

const dot = (u: Vector, v: Vector) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: Vector, v: Vector): Vector => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];
const length = (u: Vector) => Math.hypot(u[0], u[1], u[2]);
/** Angle between two directions; `atan2` keeps full precision at every angle, unlike `acos`. */
const angleBetween = (u: Vector, v: Vector) => Math.atan2(length(cross(u, v)), dot(u, v));

/** Where a point sits relative to a route, in radians. */
export interface RoutePosition {
  /** Along the route from its first point to the route point nearest the station. */
  along: number;
  /** From the station to that nearest route point. */
  off: number;
}

/** A route ready to place points against. */
export interface RouteGeometry {
  /** The route's length along its legs, in radians. */
  length: number;
  /** Place a point against the route: its nearest route point, and how far along and off it is. */
  locate(latitude: number, longitude: number): RoutePosition;
}

interface Leg {
  end: Vector;
  length: number;
  /** Unit normal of the leg's great circle; absent for a leg between two coincident points. */
  normal: Vector | undefined;
  /** Along-route angle at the leg's start. */
  offset: number;
  start: Vector;
}

/**
 * Two candidates closer than this (about 6 µm on the Earth) are a tie, which goes to the leg earlier
 * along the route: a route that doubles back reaches the same point from two legs, and their
 * arithmetic differs in the last bits.
 */
const TIE_RADIANS = 1e-12;

/** The point of one leg nearest `p`. */
function nearestOnLeg(leg: Leg, p: Vector): RoutePosition {
  if (leg.normal) {
    const sinOff = dot(p, leg.normal);
    // The foot of the perpendicular from p to the leg's great circle, unnormalized (|foot| = cos off).
    const foot: Vector = [
      p[0] - sinOff * leg.normal[0],
      p[1] - sinOff * leg.normal[1],
      p[2] - sinOff * leg.normal[2],
    ];
    const footLength = length(foot);
    if (footLength > 0) {
      const along = Math.atan2(dot(cross(leg.start, foot), leg.normal), dot(leg.start, foot));
      if (along >= 0 && along <= leg.length) {
        return { along: leg.offset + along, off: Math.atan2(Math.abs(sinOff), footLength) };
      }
    }
  }
  // The foot lies off the leg (or the leg is a point, or p is a pole of its great circle, where every
  // point of the circle is equally far): the distance from p only grows away from the foot, so the
  // nearer endpoint is the nearest point. The start wins a tie.
  const toStart = angleBetween(p, leg.start);
  const toEnd = angleBetween(p, leg.end);
  return toEnd < toStart
    ? { along: leg.offset + leg.length, off: toEnd }
    : { along: leg.offset, off: toStart };
}

/**
 * Build a route whose legs are great-circle arcs between consecutive points — the shortest path, and
 * the edge Open Charge Map's spatial index draws between the vertices of the corridor it buffers
 * around the route, so the corridor follows these arcs rather than straight lines in latitude and
 * longitude. A station's position is exact spherical geometry: the perpendicular from the station to
 * each leg's great circle when its foot falls on the leg, otherwise the nearer endpoint; the nearest
 * point over every leg wins, the earliest along the route on a tie, and `along` sums the great-circle
 * lengths of the legs before it. Every leg must span less than 180° of longitude, which rules out the
 * antipodal pair whose great circle is undefined.
 */
export function routeGeometry(points: readonly RoutePoint[]): RouteGeometry {
  const legs: Leg[] = [];
  let offset = 0;
  let start: Vector | undefined;
  for (const point of points) {
    const end = toVector(point.latitude, point.longitude);
    if (!start) {
      start = end;
      continue;
    }
    const normal = cross(start, end);
    const sinLength = length(normal);
    const legLength = Math.atan2(sinLength, dot(start, end));
    legs.push({
      start,
      end,
      length: legLength,
      normal:
        sinLength > 0
          ? [normal[0] / sinLength, normal[1] / sinLength, normal[2] / sinLength]
          : undefined,
      offset,
    });
    offset += legLength;
    start = end;
  }

  return {
    length: offset,
    locate(latitude, longitude) {
      const p = toVector(latitude, longitude);
      let best: RoutePosition = { along: 0, off: Number.POSITIVE_INFINITY };
      for (const leg of legs) {
        const candidate = nearestOnLeg(leg, p);
        if (candidate.off < best.off - TIE_RADIANS) best = candidate;
      }
      return best;
    },
  };
}

/** Open Charge Map simplifies its corridor polygon with this tolerance, in degrees. */
const SIMPLIFY_TOLERANCE_DEGREES = 0.001;
/** Its polygon's vertices are 32-bit floats: half a unit in the last place at 180° is 7.6e-6°. */
const FLOAT32_SLACK_DEGREES = 1e-5;

/**
 * The buffer, in degrees, Open Charge Map has to draw around the route so its corridor holds every
 * station within `halfWidth` radians of it, or — when that buffer would cross ±90° latitude or ±180°
 * longitude — the widest half-width whose buffer fits (0 when none does).
 *
 * Open Charge Map widens the polyline by a planar buffer in degrees (`distance` km / 200 of them), so
 * one degree of buffer covers a degree of latitude but only cos φ of a degree of longitude. A station
 * within `halfWidth` of the route sits within `halfWidth / cos φ*` degrees of it, where φ* is the
 * highest latitude it can reach: the route's highest absolute latitude plus the half-width. Three
 * margins follow. The buffer rounds its caps with `points.length` segments per quarter circle, whose
 * chords cut inside the circle by a factor cos(π / 4n), and rounds each corner with the nearest
 * whole number of those segments, so a corner's chord can span just under one and a half of them
 * and cut inside by cos(3π / 8n). The spatial index draws each chord as a great-circle arc, which
 * bows poleward by at most (chord²·π/2880)° — inward on the equator-facing caps. The polygon is then
 * simplified at 0.001° and stored as 32-bit floats.
 *
 * The buffer has to stay inside the map: a corridor polygon that crosses ±90° latitude fails the
 * whole request (Open Charge Map answers with an empty body), and one that crosses ±180° longitude
 * silently loses stations next to the route. So the room is the smallest distance from a route point
 * to a pole or to ±180°, and a corridor whose buffer outgrows it is refused rather than clipped.
 */
export function corridorBuffer(
  points: readonly RoutePoint[],
  halfWidth: number,
): { degrees: number } | { widest: number } {
  const room = Math.min(
    ...points.map((p) => Math.min(90 - Math.abs(p.latitude), 180 - Math.abs(p.longitude))),
  );
  const highest = Math.max(...points.map((p) => Math.abs(p.latitude)));
  // Half the widest chord's angle: a cap's segment, or past two points a corner's wider one.
  const halfStep = ((points.length > 2 ? 3 : 2) * Math.PI) / (8 * points.length);
  const bufferFor = (angle: number) => {
    const degrees = angle / RADIANS_PER_DEGREE;
    const reach = Math.min(90, highest + degrees) * RADIANS_PER_DEGREE;
    const radius = degrees / Math.cos(reach) / Math.cos(halfStep);
    const chord = 2 * radius * Math.sin(halfStep);
    return (
      radius + (chord * chord * Math.PI) / 2880 + SIMPLIFY_TOLERANCE_DEGREES + FLOAT32_SLACK_DEGREES
    );
  };

  const degrees = bufferFor(halfWidth);
  if (degrees <= room) return { degrees };
  if (bufferFor(0) > room) return { widest: 0 };
  // The buffer grows with the half-width, so bisect for the widest one that fits.
  let fits = 0;
  let overflows = halfWidth;
  for (let i = 0; i < 60; i++) {
    const mid = (fits + overflows) / 2;
    if (bufferFor(mid) <= room) fits = mid;
    else overflows = mid;
  }
  return { widest: fits };
}
