/**
 * @fileoverview Spherical geometry for bounding-box searches: a box's center, the great-circle angle
 * from that center to the farthest point of the box, and whether a point lies inside the box. Angles
 * are radians on a unit sphere, so each caller scales them by whichever Earth radius its metric uses.
 * @module services/openchargemap/search-geometry
 */

import type { BoundingBox } from './types.js';

const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * Great-circle angle in radians between two points given in degrees. The `atan2` form keeps full
 * precision at every angle; haversine's `asin` cannot resolve angles within 2^-25 rad of π, so a box
 * holding the antipode of its center would come back short of that point.
 */
function angularDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = lat1 * RADIANS_PER_DEGREE;
  const phi2 = lat2 * RADIANS_PER_DEGREE;
  const dLng = (lng2 - lng1) * RADIANS_PER_DEGREE;
  const across = Math.cos(phi2) * Math.sin(dLng);
  const along = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  const dot = Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return Math.atan2(Math.hypot(across, along), dot);
}

/** A box's center and the circle around it that holds the whole box. */
export interface BoxCircle {
  /** True when `sw_lng > ne_lng`: the box spans ±180° rather than the opposite, wider span. */
  crossesAntimeridian: boolean;
  /** Angle in radians from the center to the farthest point of the box. */
  farthestAngle: number;
  latitude: number;
  /** In `(-180, 180]`; the midpoint across ±180° for a box that crosses it. */
  longitude: number;
}

/**
 * Center a box and measure the farthest point of it from that center. The latitude corners may come
 * in either order. A box whose `sw_lng` exceeds its `ne_lng` crosses ±180°.
 *
 * The farthest point is not always a corner. Along a parallel the distance grows with the longitude
 * offset, so the north and south edges peak at their ends. Along the east and west meridians, though,
 * `cos d = sin φc·sin φ + cos φc·cos Δ·cos φ` has one turning point at `tan φ = tan φc / cos Δ`, and
 * once the half-width Δ passes 90° that turning point is a maximum: a 340°-wide equatorial box is
 * farthest from its center at the middle of its east edge. Taking the larger of the corner and the
 * turning point (when it lies on the edge) covers every case. The interior never holds the maximum —
 * the distance from a point has no peak short of the antipode, and the antipode of the center can only
 * fall on the east/west edge, when the box is a full 360° wide.
 */
export function boxCircle(box: BoundingBox): BoxCircle {
  const south = Math.min(box.sw_lat, box.ne_lat);
  const north = Math.max(box.sw_lat, box.ne_lat);
  const crossesAntimeridian = box.sw_lng > box.ne_lng;
  const halfWidth = ((crossesAntimeridian ? 360 : 0) + box.ne_lng - box.sw_lng) / 2;
  const midLongitude = box.sw_lng + halfWidth;
  const latitude = (south + north) / 2;

  // Distance to a point on the east edge, measured with the center at longitude 0.
  const toEdge = (lat: number) => angularDistance(latitude, 0, lat, halfWidth);
  const angles = [toEdge(south), toEdge(north)];
  const cosHalfWidth = Math.cos(halfWidth * RADIANS_PER_DEGREE);
  if (cosHalfWidth !== 0) {
    const turn =
      Math.atan(Math.tan(latitude * RADIANS_PER_DEGREE) / cosHalfWidth) / RADIANS_PER_DEGREE;
    if (turn > south && turn < north) angles.push(toEdge(turn));
  }

  return {
    crossesAntimeridian,
    farthestAngle: Math.max(...angles),
    latitude,
    longitude: midLongitude > 180 ? midLongitude - 360 : midLongitude,
  };
}

/**
 * True when a point lies inside the box, edges included. A box that crosses ±180° holds the longitudes
 * east of its west edge or west of its east edge; -180° and 180° name the same meridian.
 */
export function boxContains(box: BoundingBox, latitude: number, longitude: number): boolean {
  if (latitude < Math.min(box.sw_lat, box.ne_lat) || latitude > Math.max(box.sw_lat, box.ne_lat)) {
    return false;
  }
  const withinSpan = (lng: number) =>
    box.sw_lng <= box.ne_lng
      ? lng >= box.sw_lng && lng <= box.ne_lng
      : lng >= box.sw_lng || lng <= box.ne_lng;
  return withinSpan(longitude) || (Math.abs(longitude) === 180 && withinSpan(-longitude));
}
