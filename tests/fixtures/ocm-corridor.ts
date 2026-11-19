/**
 * @fileoverview An independent replica of the corridor polygon Open Charge Map searches along a
 * route, for outcome tests of the buffer the server sends. Built from OCM's source and the
 * NetTopologySuite buffer it calls, sharing no code with the server: OCM widens the polyline by a
 * planar buffer in degrees with round caps and round joins and as many segments per quarter circle
 * as the route has points; NTS rounds each corner's segment count to the nearest whole number of
 * those steps and draws a single corner where two offset ends nearly meet; OCM simplifies the
 * polygon at 0.001° and keeps its vertices as 32-bit floats; its spatial index joins them with
 * great-circle arcs. Points are tested exactly, by gnomonic projection.
 * @module tests/fixtures/ocm-corridor
 */

/** A route point or a test point, in degrees. */
export interface LatLng {
  latitude: number;
  longitude: number;
}

type Vector = readonly [number, number, number];
/** A planar point in degrees, `[longitude, latitude]`, as the buffer sees the route. */
type Planar = readonly [number, number];
type Side = 'left' | 'right';

const RADIANS = Math.PI / 180;
/** The tolerance OCM simplifies its corridor polygon with, in degrees. */
const SIMPLIFY_TOLERANCE = 0.001;
/** NTS draws a single corner when two offset ends lie closer than this fraction of the distance. */
const OFFSET_SEPARATION_FACTOR = 0.05;

function toVector(latitude: number, longitude: number): Vector {
  const phi = latitude * RADIANS;
  const lambda = longitude * RADIANS;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

const dot = (u: Vector, v: Vector) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: Vector, v: Vector): Vector => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];
const scale = (u: Vector, k: number): Vector => [u[0] * k, u[1] * k, u[2] * k];
const add = (u: Vector, v: Vector): Vector => [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
const normalize = (u: Vector): Vector => scale(u, 1 / Math.hypot(u[0], u[1], u[2]));
/** The point `angle` radians from `from` toward the perpendicular direction `toward`. */
const turnToward = (from: Vector, toward: Vector, angle: number): Vector =>
  add(scale(from, Math.cos(angle)), scale(toward, Math.sin(angle)));

/** Rounded to a 32-bit float, as OCM's geometry factory stores every vertex. */
const float32 = ([x, y]: Planar): Planar => [Math.fround(x), Math.fround(y)];

/** Distance from `p` to the segment `a`–`b`, in degrees. */
function segmentDistance(p: Planar, a: Planar, b: Planar): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker over an open polyline at OCM's tolerance, keeping both ends. */
function simplify(line: Planar[]): Planar[] {
  const keep = line.map((_, i) => i === 0 || i === line.length - 1);
  const section = (first: number, last: number) => {
    let farthest = -1;
    let distance = -1;
    for (let k = first + 1; k < last; k++) {
      const d = segmentDistance(line[k]!, line[first]!, line[last]!);
      if (d > distance) {
        distance = d;
        farthest = k;
      }
    }
    if (farthest >= 0 && distance > SIMPLIFY_TOLERANCE) {
      keep[farthest] = true;
      section(first, farthest);
      section(farthest, last);
    }
  };
  section(0, line.length - 1);
  return line.filter((_, i) => keep[i]);
}

/** One convex piece of the corridor, projected about its center so its great-circle edges are straight. */
interface Piece {
  center: Vector;
  east: Vector;
  north: Vector;
  ring: Planar[];
}

function toPiece(ring: Planar[]): Piece {
  const vectors = ring.map(([longitude, latitude]) => toVector(latitude, longitude));
  const center = normalize(vectors.reduce(add, [0, 0, 0]));
  const east = normalize(cross(Math.abs(center[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], center));
  const north = cross(center, east);
  const piece = { center, east, north, ring: [] as Planar[] };
  piece.ring = vectors.map((v) => project(piece, v));
  return piece;
}

/** Gnomonic projection about the piece's center, which maps every great-circle arc to a line. */
function project(piece: Omit<Piece, 'ring'>, v: Vector): Planar {
  const k = dot(v, piece.center);
  return [dot(v, piece.east) / k, dot(v, piece.north) / k];
}

function contains(piece: Piece, p: Vector): boolean {
  if (dot(p, piece.center) <= 0) return false;
  const [x, y] = project(piece, p);
  let inside = false;
  for (let i = 0, j = piece.ring.length - 1; i < piece.ring.length; j = i++) {
    const [xi, yi] = piece.ring[i]!;
    const [xj, yj] = piece.ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The corridor OCM searches for `route` buffered by `degrees`, as the pieces whose union it is: each
 * leg's offset rectangle, a round cap at each end, and a round join outside each turn. Neighbouring
 * pieces share the vertices of their common edges, so no seam opens between their great-circle arcs.
 */
function corridorPieces(route: LatLng[], degrees: number): Piece[] {
  const points: Planar[] = [];
  for (const { latitude, longitude } of route) {
    const point = float32([longitude, latitude]);
    const previous = points.at(-1);
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
  }
  if (points.length < 2) return [];
  const quantum = Math.PI / 2 / route.length;
  const offset = (p: Planar, angle: number): Planar =>
    float32([p[0] + degrees * Math.cos(angle), p[1] + degrees * Math.sin(angle)]);
  const normal = { left: Math.PI / 2, right: -Math.PI / 2 } satisfies Record<Side, number>;
  /** A round cap or join around `center`, segmented as NTS segments it and simplified as OCM does. */
  const fillet = (center: Planar, start: number, sweep: number, from: Planar, to: Planar) => {
    const segments = Math.floor(Math.abs(sweep) / quantum + 0.5);
    const between = Array.from({ length: Math.max(0, segments - 1) }, (_, k) =>
      offset(center, start + ((k + 1) * sweep) / segments),
    );
    return simplify([from, ...between, to]);
  };

  const legs = points.slice(1).map((end, i) => {
    const start = points[i]!;
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    return {
      angle,
      length: Math.hypot(end[0] - start[0], end[1] - start[1]),
      left: [offset(start, angle + normal.left), offset(end, angle + normal.left)],
      right: [offset(start, angle + normal.right), offset(end, angle + normal.right)],
    };
  });
  const first = legs[0]!;
  const last = legs.at(-1)!;
  const pieces = [
    toPiece([
      points[0]!,
      ...fillet(points[0]!, first.angle - Math.PI / 2, -Math.PI, first.right[0]!, first.left[0]!),
    ]),
    toPiece([
      points.at(-1)!,
      ...fillet(points.at(-1)!, last.angle + Math.PI / 2, -Math.PI, last.left[1]!, last.right[1]!),
    ]),
  ];
  for (let i = 1; i < points.length - 1; i++) {
    const before = legs[i - 1]!;
    const after = legs[i]!;
    const turn = Math.atan2(
      Math.sin(after.angle - before.angle),
      Math.cos(after.angle - before.angle),
    );
    if (turn === 0) continue;
    // A left turn's outside is its right; a reversal is rounded like a cap.
    const side: Side = turn > 0 ? 'right' : 'left';
    const from = before[side][1]!;
    const to = after[side][0]!;
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < OFFSET_SEPARATION_FACTOR * degrees) {
      // The corner is the offset end of the longer leg.
      if (before.length > after.length) after[side][0] = from;
      else before[side][1] = to;
      continue;
    }
    pieces.push(
      toPiece([points[i]!, ...fillet(points[i]!, before.angle + normal[side], turn, from, to)]),
    );
  }
  legs.forEach(({ left, right }, i) => {
    pieces.push(toPiece([left[0]!, left[1]!, points[i + 1]!, right[1]!, right[0]!, points[i]!]));
  });
  return pieces;
}

/**
 * Points `fraction` of `halfWidth` radians from the route's great-circle legs: both sides of 41
 * points along each leg, and 180 directions around each route point.
 */
function pointsAround(route: LatLng[], halfWidth: number, fraction: number): Vector[] {
  const reach = fraction * halfWidth;
  const out: Vector[] = [];
  route.slice(1).forEach((end, i) => {
    const a = toVector(route[i]!.latitude, route[i]!.longitude);
    const b = toVector(end.latitude, end.longitude);
    const pole = cross(a, b);
    const sin = Math.hypot(...pole);
    if (sin === 0) return;
    const normal = scale(pole, 1 / sin);
    const length = Math.atan2(sin, dot(a, b));
    const forward = cross(normal, a);
    for (let k = 0; k <= 40; k++) {
      const q = turnToward(a, forward, (length * k) / 40);
      out.push(turnToward(q, normal, reach), turnToward(q, scale(normal, -1), reach));
    }
  });
  for (const { latitude, longitude } of route) {
    const c = toVector(latitude, longitude);
    const east = normalize(cross([0, 0, 1], c));
    const north = cross(c, east);
    for (let k = 0; k < 180; k++) {
      const bearing = (k * Math.PI) / 90;
      out.push(turnToward(c, turnToward(east, north, bearing), reach));
    }
  }
  return out;
}

/**
 * The points within `halfWidth` radians of `route` that the corridor OCM draws with a buffer of
 * `degrees` leaves out, sampled at `fraction` of the half-width. Empty when the buffer covers them.
 */
export function uncoveredPoints(
  route: LatLng[],
  halfWidth: number,
  degrees: number,
  fraction = 0.999,
): LatLng[] {
  const pieces = corridorPieces(route, degrees);
  return pointsAround(route, halfWidth, fraction)
    .filter((p) => !pieces.some((piece) => contains(piece, p)))
    .map(([x, y, z]) => ({
      latitude: Number((Math.asin(z) / RADIANS).toFixed(5)),
      longitude: Number((Math.atan2(y, x) / RADIANS).toFixed(5)),
    }));
}
