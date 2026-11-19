/**
 * @fileoverview Open Charge Map service — HTTP client over the OCM `/v3/poi` endpoint with retry,
 * session-level result caching, and response normalization. Search uses `verbose=false` and
 * single-station detail `verbose=true`; the flag only decides whether null-valued keys are sent, so
 * both carry every populated field. Failed requests are translated to contract reasons
 * (`auth_failed` for 401/403, `upstream_unavailable` otherwise, retryable only for transient
 * failures — see `translateFetchError`) so calling tools surface a stable `data.reason`; one
 * deadline bounds each fetch's whole retry ladder.
 * @module services/openchargemap/openchargemap-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  fetchWithTimeout,
  type RequestContext,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { getReferenceDataService } from '@/services/reference-data/reference-data-service.js';
import { isPlaceholderCoordinate } from './attribution.js';
import { corridorBuffer, encodePolyline, routeGeometry } from './route-geometry.js';
import { boxCircle, boxContains } from './search-geometry.js';
import type {
  DistanceUnit,
  NormalizedComment,
  NormalizedConnection,
  NormalizedStation,
  NormalizedStationDetail,
  RawConnection,
  RawPoi,
  RawUserComment,
  RoutePoint,
  SearchArea,
  SearchLocation,
  SearchPoiParams,
  SearchPoiResult,
} from './types.js';

/** Result-cache TTL in seconds — station status drifts over minutes, not seconds. */
const CACHE_TTL_SECONDS = 600;

/**
 * The deepest candidate pool `searchPois` can serve; one extra record detects an upstream remainder. Bounded
 * because OCM has no offset parameter — the whole reachable set has to come back in one response —
 * and because response time past this size grows unreliable against the 15s fetch timeout.
 */
export const MAX_SEARCH_WINDOW = 500;

/** Map the OCM integer distance-unit enum to a string. */
function distanceUnitLabel(raw: number | null | undefined): 'KM' | 'Miles' | undefined {
  if (raw === 1) return 'KM';
  if (raw === 2) return 'Miles';
  return;
}

/** Serialize an array filter to a comma-joined string, or a scalar as-is. */
function joinFilter(value: number | number[] | undefined): string | undefined {
  if (value === undefined) return;
  return Array.isArray(value) ? value.join(',') : String(value);
}

/**
 * True when a decoded `/v3/poi` array member is readable as a POI record. Deliberately shallow —
 * only object-ness, no field requirements: OCM omits most fields on legitimately sparse records, so
 * any stricter shape check would reject real stations. It exists to stop a `null`, string, or number
 * member from reaching normalization, where property access throws a raw `TypeError`.
 */
function isPoiRecord(value: unknown): value is RawPoi {
  return typeof value === 'object' && value !== null;
}

/**
 * True when a raw POI carries usable coordinates. OCM stores some records at or a few metres off 0,0
 * ({@link isPlaceholderCoordinate}: false near-zero-distance matches otherwise) and omits lat/lng on
 * others (which `normalizeStation` then defaults to 0,0). Both are unusable for a proximity search, so
 * it drops them — checked on the raw address, ahead of the `?? 0` default that erases the distinction.
 */
function hasUsableCoordinates(poi: RawPoi): boolean {
  const lat = poi.AddressInfo?.Latitude;
  const lng = poi.AddressInfo?.Longitude;
  return typeof lat === 'number' && typeof lng === 'number' && !isPlaceholderCoordinate(lat, lng);
}

/**
 * Resolve a station's charge-point count: `numberOfPoints` when present, else the summed connection
 * quantities (OCM omits `numberOfPoints` on ~96% of records). Undefined when neither signal exists —
 * an unknown count, not zero.
 */
function chargePointCount(station: NormalizedStation): number | undefined {
  if (typeof station.numberOfPoints === 'number') return station.numberOfPoints;
  const known = station.connections
    .map((c) => c.quantity)
    .filter((q): q is number => typeof q === 'number');
  return known.length > 0 ? known.reduce((sum, q) => sum + q, 0) : undefined;
}

/**
 * Local charge-point filter honoring the `minchargepoints` contract (OCM's `minnumberofpoints` query
 * param is inert). A station with no count signal at all is unknown, not below-minimum, so it is kept.
 */
function meetsMinChargePoints(station: NormalizedStation, min: number | undefined): boolean {
  if (min === undefined) return true;
  const count = chargePointCount(station);
  return count === undefined || count >= min;
}

/**
 * Earth radii Open Charge Map measures a record's `Distance` with (`GeoManager.CalcDistance`). A box's
 * farthest-point distance uses the same ones, so it compares directly against the rows' distances.
 */
const REPORTED_EARTH_RADIUS: Record<DistanceUnit, number> = { KM: 6371, Miles: 3959 };

/**
 * The `distance` to send so Open Charge Map's search circle reaches a great-circle angle. OCM converts
 * miles to km at 0.621371192 miles per km and hands the km to MongoDB's `$nearSphere` in metres, which
 * MongoDB turns back into an angle over a 6378.1 km radius — larger than the 6371 km OCM reports
 * distances with, so a radius sent as-is reaches 0.11% short of itself (a 7.93 km search leaves out
 * stations OCM reports at 7.924–7.930 km). Rounded up to the metre, plus one, so a point on the
 * boundary stays inside.
 */
function queryDistance(angle: number, unit: DistanceUnit): number {
  const km = angle * 6378.1;
  return (Math.ceil((unit === 'Miles' ? km * 0.621371192 : km) * 1000) + 1) / 1000;
}

/** A station the requested area keeps, with the key the pool is ordered by. */
interface Placed {
  /** Compared in order, then station `id`. */
  rank: readonly [number, number];
  station: NormalizedStation;
}

/** A location resolved for one search. */
interface ResolvedLocation {
  /** What the caller is told about the search. */
  area: SearchArea;
  /**
   * The station as the requested area keeps it, carrying its route position in a route search, or
   * undefined when it lies outside the area: the distance search around a box also reaches the
   * segments of the circle beyond the box's edges, and the corridor Open Charge Map buffers around
   * a route is wider than the requested one.
   */
  place: (station: NormalizedStation) => Placed | undefined;
  /** The location parameters Open Charge Map receives. */
  query: Record<string, string>;
}

/** Ranked by distance from the search point; a station without one sorts after every station with one. */
function byDistance(station: NormalizedStation): Placed {
  return { rank: [station.distance ?? Number.POSITIVE_INFINITY, 0], station };
}

/**
 * Pool order: rank, then station `id` — co-located stations share a distance, and the tie-break keeps
 * a refetched pool in the order earlier pages were cut from. Two stations ranked at infinity compare
 * as `NaN`, which falls through to the next key like a tie.
 */
function byRankThenId(a: Placed, b: Placed): number {
  return a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.station.id - b.station.id;
}

/** A distance search: records come back nearest first, each with its `Distance` from the point. */
function distanceQuery(
  latitude: number,
  longitude: number,
  angle: number,
  unit: DistanceUnit,
): Record<string, string> {
  return {
    latitude: String(latitude),
    longitude: String(longitude),
    distance: String(queryDistance(angle, unit)),
    distanceunit: unit,
  };
}

/**
 * Resolve a location into the upstream search that covers it. A bounding box is searched from its
 * center out to its farthest point and narrowed back to the box afterwards: OCM's own `boundingbox`
 * parameter evaluates a geodesic polygon whose east–west edges bow poleward, which returns stations
 * outside a wide box, never returns some inside it, and reads a box crossing ±180° as its complement.
 * A route runs as OCM's polyline search, widened to cover the requested corridor and narrowed back to
 * it ({@link resolveRoute}).
 */
function resolveLocation(location: SearchLocation): ResolvedLocation {
  switch (location.mode) {
    case 'radius':
      return {
        area: location,
        place: byDistance,
        query: distanceQuery(
          location.latitude,
          location.longitude,
          location.distance / REPORTED_EARTH_RADIUS[location.distanceUnit],
          location.distanceUnit,
        ),
      };
    case 'box': {
      const { box, distanceUnit } = location;
      const circle = boxCircle(box);
      return {
        area: {
          mode: 'box',
          box,
          crossesAntimeridian: circle.crossesAntimeridian,
          distance: circle.farthestAngle * REPORTED_EARTH_RADIUS[distanceUnit],
          distanceUnit,
          latitude: circle.latitude,
          longitude: circle.longitude,
        },
        place: (station) =>
          boxContains(box, station.address.latitude, station.address.longitude)
            ? byDistance(station)
            : undefined,
        query: distanceQuery(circle.latitude, circle.longitude, circle.farthestAngle, distanceUnit),
      };
    }
    case 'route':
      return resolveRoute(location.route, location.distance, location.distanceUnit);
    default: {
      const unhandled: never = location;
      throw new Error(`Unhandled search location: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * A station distance as the caller reads it: rounded to hundredths, the precision the text renders, so
 * `structuredContent` carries the same value and the pool sorts on what the caller sees.
 */
function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A route search the corridor geometry refuses, with the next move as its recovery hint. */
function unsearchableRoute(message: string, hint: string): McpError {
  return invalidParams(message, { reason: 'invalid_location', recovery: { hint } });
}

/**
 * A route search that ran out the request timeout. Unlike any other timeout it is not retried: the
 * same request takes as long again, so a retry would only spend the deadline and fail the same way.
 */
function routeTimedOut(cause: McpError): McpError {
  return serviceUnavailable(
    `Open Charge Map did not answer this route search within the ${REQUEST_TIMEOUT_MS / 1000} s request timeout.`,
    {
      reason: 'upstream_unavailable',
      retryable: false,
      recovery: {
        hint: 'Send the route with fewer points, or search a stretch of it with a center or a boundingbox.',
      },
    },
    { cause },
  );
}

/**
 * Resolve a route into Open Charge Map's polyline search. OCM buffers the polyline by `distance`/200
 * degrees, which is not a corridor of `distance` km — at 47° N its 5 km buffer reaches 2.8 km north
 * and 1.9 km east — so the request carries the buffer that covers the requested corridor everywhere
 * ({@link corridorBuffer}), always in km, and the stations it returns are narrowed back to those
 * within `distance` of the route. OCM returns them newest first with no `Distance`, so each station
 * gets its own position along and off the route, and the pool runs in the order a driver meets them.
 *
 * Refused before any request: a leg spanning 180° of longitude or more (OCM's planar buffer wraps it
 * around the globe), and a corridor whose buffer would cross a pole or ±180° longitude.
 */
function resolveRoute(route: RoutePoint[], distance: number, unit: DistanceUnit): ResolvedLocation {
  route.forEach((point, i) => {
    const previous = route[i - 1];
    const span = previous ? Math.abs(point.longitude - previous.longitude) : 0;
    if (span >= 180) {
      throw unsearchableRoute(
        `route[${i - 1}] and route[${i}] are ${Number(span.toFixed(6))}° of longitude apart; each leg of a route must span less than 180°.`,
        'Add points to split a leg that long. A route that crosses ±180° longitude has to be searched as two routes, one on each side ending short of the meridian, or covered with a boundingbox, which can span it.',
      );
    }
  });

  const radius = REPORTED_EARTH_RADIUS[unit];
  const buffer = corridorBuffer(route, distance / radius);
  if ('widest' in buffer) {
    const widest = Math.floor(buffer.widest * radius * 100) / 100;
    throw unsearchableRoute(
      `A ${distance} ${unit} corridor around this route reaches past a pole or ±180° longitude, which Open Charge Map's corridor search cannot cross.`,
      widest > 0
        ? `Narrow distance to ${widest} ${unit} or less, or search the stretch nearest the pole or ±180° longitude with a center or a boundingbox.`
        : 'A point of this route lies too close to a pole or to ±180° longitude for any corridor; search that stretch with a center or a boundingbox instead.',
    );
  }

  const geometry = routeGeometry(route);
  return {
    area: { mode: 'route', route, distance, distanceUnit: unit, length: geometry.length * radius },
    // Ranked by the rounded values the caller reads, so the order never contradicts them.
    place: (station) => {
      const { along, off } = geometry.locate(station.address.latitude, station.address.longitude);
      if (off * radius > distance) return;
      const routeDistance = hundredths(along * radius);
      const offRouteDistance = hundredths(off * radius);
      return {
        rank: [routeDistance, offRouteDistance],
        station: { ...station, distanceUnit: unit, routeDistance, offRouteDistance },
      };
    },
    query: {
      // Rounded up to the metre, so the buffer never falls short of the one computed.
      distance: String(Math.ceil(buffer.degrees * 200 * 1000) / 1000),
      distanceunit: 'KM',
      polyline: encodePolyline(route),
    },
  };
}

/**
 * The longest request target (path and query) Open Charge Map accepts: its server takes a request
 * line of at most 8,192 bytes, so `GET `, ` HTTP/1.1`, and the line break leave 8,177 for the target
 * (measured: 8,177 → 200, 8,178 → 414). Only a route's polyline can grow a search that long.
 */
const MAX_REQUEST_TARGET_BYTES = 8177;

/** The largest `Distance` among raw records, or undefined when none carries one. */
function farthestDistance(pool: RawPoi[]): number | undefined {
  const distances = pool
    .map((poi) => poi.AddressInfo?.Distance)
    .filter((distance): distance is number => typeof distance === 'number');
  return distances.length > 0 ? Math.max(...distances) : undefined;
}

/** Bounds one request to Open Charge Map, headers and body together. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Bounds one fetch's whole retry ladder, so a hung upstream fails before a 60 s client gives up. */
const RETRY_DEADLINE_MS = 50_000;

/**
 * Hash a composed cache key to a storage-safe token. The framework's key validator allows only
 * `[a-zA-Z0-9_.\-/]` — no colons — so segments join with hyphens (the hash is hex, also safe).
 */
function cacheKey(prefix: string, payload: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
  return `ocm-${prefix}-${hash}`;
}

export class OpenChargeMapService {
  constructor(private readonly serverConfig: ServerConfig) {}

  /**
   * Search POIs around a point, within a bounding box, or along a route, with optional filters
   * (`verbose=false`), returning the whole candidate page the local filters left in the area's order
   * — the caller slices its own window out of it. One fixed 500-candidate pool per search and filter
   * set is cached in `ctx.state`, independently of page size and offset. A 501st raw record only
   * proves an upstream remainder. A route Open Charge Map cannot search, or whose request would run
   * past {@link MAX_REQUEST_TARGET_BYTES}, fails `invalid_location` before any request; a route
   * search Open Charge Map does not answer within the request timeout fails at once, not retried.
   */
  async searchPois(params: SearchPoiParams, ctx: Context): Promise<SearchPoiResult> {
    const candidateCap = MAX_SEARCH_WINDOW;
    // v3: earlier pools held bounding boxes in Open Charge Map's spatial-index order, without distances.
    const key = cacheKey('search-v3', { ...params, candidateCap });
    const cached = await ctx.state.get<SearchPoiResult>(key);
    if (cached) {
      ctx.log.debug('OCM search cache hit', { key });
      return cached;
    }

    const located = resolveLocation(params.location);
    const url = this.buildSearchUrl(params, located.query, candidateCap + 1);
    if (params.location.mode === 'route') {
      const target = new URL(url);
      const bytes = target.pathname.length + target.search.length;
      if (bytes > MAX_REQUEST_TARGET_BYTES) {
        throw unsearchableRoute(
          `This route makes a ${bytes}-byte request to Open Charge Map, past the ${MAX_REQUEST_TARGET_BYTES} bytes it accepts.`,
          'Send fewer route points: thin out densely sampled geometry, keeping the points where the route turns.',
        );
      }
    }
    const raw = await this.fetchPois(
      url,
      'searchPois',
      ctx,
      params.location.mode === 'route' ? routeTimedOut : undefined,
    );
    const pool = raw.slice(0, candidateCap);
    // Search-only response filters (getPoi keeps everything): drop unusable-coordinate POIs on the
    // RAW address before normalization's `?? 0` erases the 0,0-vs-missing distinction, drop records
    // outside the requested area, then honor the minchargepoints contract locally since OCM's
    // minnumberofpoints param is inert. All run over the full candidate page, so a match ranked past
    // the caller's window is not lost to the cap.
    const matches = pool
      .filter(hasUsableCoordinates)
      .map((poi) => located.place(this.normalizeStation(poi)))
      .filter((placed): placed is Placed => placed !== undefined)
      .filter(({ station }) => meetsMinChargePoints(station, params.minchargepoints))
      .sort(byRankThenId)
      .map(({ station }) => station);
    const reach = farthestDistance(pool);
    const result: SearchPoiResult = {
      area: located.area,
      candidateCap,
      fetched: pool.length,
      matches,
      moreUpstream: raw.length > candidateCap,
      ...(reach === undefined ? {} : { reach }),
    };
    await ctx.state.set(key, result, { ttl: CACHE_TTL_SECONDS });
    return result;
  }

  /**
   * Fetch a single station's full record by numeric OCM ID (`verbose=true`).
   * Returns `null` when OCM responds HTTP 200 with `[]` (no such station) — the caller throws
   * `not_found`. `includeComments` embeds `UserComments[]`.
   */
  async getPoi(
    id: number,
    options: { includeComments: boolean },
    ctx: Context,
  ): Promise<NormalizedStationDetail | null> {
    const key = cacheKey('poi', { id, includeComments: options.includeComments });
    const cached = await ctx.state.get<NormalizedStationDetail | 'EMPTY'>(key);
    if (cached === 'EMPTY') return null;
    if (cached) {
      ctx.log.debug('OCM detail cache hit', { key, id });
      return cached;
    }

    const url = this.buildDetailUrl(id, options.includeComments);
    const raw = await this.fetchPois(url, 'getPoi', ctx);
    const [first] = raw;
    if (!first) {
      await ctx.state.set(key, 'EMPTY', { ttl: CACHE_TTL_SECONDS });
      return null;
    }
    const station = this.normalizeStationDetail(first, options.includeComments);
    await ctx.state.set(key, station, { ttl: CACHE_TTL_SECONDS });
    return station;
  }

  // --- URL construction ---

  private buildSearchUrl(
    params: SearchPoiParams,
    location: ResolvedLocation['query'],
    candidateCap: number,
  ): string {
    const qs = new URLSearchParams({
      output: 'json',
      compact: 'false',
      verbose: 'false',
      maxresults: String(candidateCap),
      ...location,
    });

    if (params.countrycode) qs.set('countrycode', params.countrycode.toUpperCase());
    if (params.minpowerkw !== undefined) qs.set('minpowerkw', String(params.minpowerkw));
    // No minimum-charge-point param is sent: OCM's `minnumberofpoints` is inert (confirmed live —
    // present or absent, the same records come back in the same order). `meetsMinChargePoints`
    // carries that contract instead.

    const conn = joinFilter(params.connectiontypeid);
    if (conn) qs.set('connectiontypeid', conn);
    const op = joinFilter(params.operatorid);
    if (op) qs.set('operatorid', op);
    const usage = joinFilter(params.usagetypeid);
    if (usage) qs.set('usagetypeid', usage);
    const level = joinFilter(params.levelid);
    if (level) qs.set('levelid', level);
    const status = joinFilter(params.statustypeid);
    if (status) qs.set('statustypeid', status);

    return `${this.serverConfig.baseUrl}/poi?${qs.toString()}`;
  }

  private buildDetailUrl(id: number, includeComments: boolean): string {
    const qs = new URLSearchParams({
      output: 'json',
      compact: 'false',
      verbose: 'true',
      chargepointid: String(id),
    });
    if (includeComments) qs.set('includecomments', 'true');
    return `${this.serverConfig.baseUrl}/poi?${qs.toString()}`;
  }

  // --- fetch + retry + error translation ---

  /**
   * Fetch and parse a POI array, with retry over the full pipeline and status→reason mapping. One
   * deadline bounds every attempt and backoff together; a ladder that runs out of it is the same
   * retryable `upstream_unavailable` an exhausted ladder is, since a later call can still succeed.
   * `timedOut`, when given, is what an attempt that runs out the request timeout fails with instead
   * of a retry.
   */
  private async fetchPois(
    url: string,
    operation: string,
    ctx: Context,
    timedOut?: (cause: McpError) => McpError,
  ): Promise<RawPoi[]> {
    const reqCtx: RequestContext = requestContextService.createRequestContext({
      operation,
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId, tenantId: ctx.tenantId },
    });
    try {
      return await withRetry(
        async ({ signal }) => {
          let response: Response;
          try {
            // The attempt's signal carries the caller's cancellation and the ladder's deadline, so the
            // deadline also ends an attempt already in flight, not just the waits between attempts.
            response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, reqCtx, {
              headers: { 'X-API-Key': this.serverConfig.apiKey },
              signal,
            });
          } catch (error) {
            throw this.translateFetchError(error, timedOut);
          }
          let data: unknown;
          try {
            data = await response.json();
          } catch (error) {
            // The request deadline follows the body, so a stall, a dropped connection, or the
            // caller cancelling mid-read rejects the read with a classified fetch failure, not a
            // parse failure — translated like one from the header phase, cancellation untouched.
            if (error instanceof McpError) throw this.translateFetchError(error, timedOut);
            throw this.malformedResponse(
              'Open Charge Map returned a body that is not valid JSON.',
              error,
            );
          }
          if (!Array.isArray(data)) {
            throw this.malformedResponse(
              'Open Charge Map returned an unexpected (non-array) response.',
            );
          }
          if (!data.every(isPoiRecord)) {
            throw this.malformedResponse(
              'Open Charge Map returned a station list containing an unreadable entry.',
            );
          }
          return data;
        },
        {
          operation,
          context: reqCtx,
          baseDelayMs: 1500,
          deadlineMs: RETRY_DEADLINE_MS,
          signal: ctx.signal,
        },
      );
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded') {
        throw serviceUnavailable(
          'Open Charge Map did not answer before the request deadline.',
          { reason: 'upstream_unavailable', retryable: true },
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * One envelope for every unreadable response body — invalid JSON, a non-array payload, or an
   * array carrying an unreadable entry. All three are the same client-facing failure as a non-2xx
   * (OCM did not return usable data), so they carry the declared `upstream_unavailable` reason and
   * stay retryable rather than surfacing as a raw parser exception. The calling tool's `errors[]`
   * entry supplies the recovery hint at the handler boundary.
   */
  private malformedResponse(message: string, cause?: unknown): Error {
    return serviceUnavailable(
      message,
      { reason: 'upstream_unavailable', retryable: true },
      { cause },
    );
  }

  /**
   * Re-tag a failed fetch with the reason the calling tools declare. `fetchWithTimeout` throws an
   * `McpError` classified from the HTTP status, and `data.retryable` decides whether `withRetry`
   * tries again:
   * - 401/403 — OCM's answer to a missing or invalid key — becomes `auth_failed`, not retryable.
   * - A transient failure (408, 425, 429, 5xx other than 501, a network error, a timeout) becomes
   *   `upstream_unavailable`, retryable; the tool's declared recovery (retry later) applies. A
   *   `Retry-After` the upstream sent stays on `data.retryAfter`, so `withRetry` waits it out (or
   *   fails at once when it outlasts the ladder) and the caller is told the wait.
   * - A request that ran out the request timeout becomes `timedOut`'s failure instead, when the
   *   caller passes one.
   * - Any other HTTP rejection (400, 404, 414, 422, 501, …) becomes `upstream_unavailable`, not
   *   retryable, with a recovery hint of its own: the same request gets the same answer.
   * - A caller cancellation passes through untouched.
   */
  private translateFetchError(error: unknown, timedOut?: (cause: McpError) => McpError): Error {
    if (timedOut && error instanceof McpError && error.data?.errorSource === 'FetchTimeout') {
      return timedOut(error);
    }
    const code = (error as { code?: number }).code;
    if (code === JsonRpcErrorCode.Unauthorized || code === JsonRpcErrorCode.Forbidden) {
      return unauthorized('Open Charge Map rejected the API key (HTTP 401/403).', {
        reason: 'auth_failed',
        retryable: false,
      });
    }
    if (!(error instanceof McpError) || defaultIsTransient(error)) {
      const retryAfter = error instanceof McpError ? error.data?.retryAfter : undefined;
      return serviceUnavailable(
        error instanceof Error ? error.message : 'Open Charge Map request failed.',
        {
          reason: 'upstream_unavailable',
          retryable: true,
          ...(retryAfter === undefined ? {} : { retryAfter }),
        },
        { cause: error },
      );
    }
    const status = error.data?.status;
    if (typeof status !== 'number') return error;
    return serviceUnavailable(
      error.message,
      {
        reason: 'upstream_unavailable',
        retryable: false,
        recovery: {
          hint: `Open Charge Map refused this request (HTTP ${status}), and sending it again unchanged gets the same refusal. Change the request's inputs, or report the failure to the server operator if they look valid.`,
        },
      },
      { cause: error },
    );
  }

  // --- normalization ---

  private normalizeStation(poi: RawPoi): NormalizedStation {
    const addr = poi.AddressInfo ?? {};
    const usage = poi.UsageType ?? undefined;
    const status = poi.StatusType ?? undefined;
    const ref = getReferenceDataService();
    const distUnit = distanceUnitLabel(addr.DistanceUnit);

    const station: NormalizedStation = {
      id: poi.ID ?? 0,
      uuid: poi.UUID ?? '',
      title: addr.Title?.trim() || `Station ${poi.ID ?? ''}`.trim(),
      address: {
        latitude: addr.Latitude ?? 0,
        longitude: addr.Longitude ?? 0,
        ...(addr.AddressLine1 ? { line1: addr.AddressLine1 } : {}),
        ...(addr.AddressLine2 ? { line2: addr.AddressLine2 } : {}),
        ...(addr.Town ? { town: addr.Town } : {}),
        ...(addr.StateOrProvince ? { stateOrProvince: addr.StateOrProvince } : {}),
        ...(addr.Postcode ? { postcode: addr.Postcode } : {}),
        ...(addr.Country?.Title ? { country: addr.Country.Title } : {}),
        ...(addr.Country?.ISOCode ? { countryCode: addr.Country.ISOCode } : {}),
        ...(addr.AccessComments ? { accessComments: addr.AccessComments } : {}),
      },
      connections: (poi.Connections ?? []).map((c) => this.normalizeConnection(c)),
      ...(typeof addr.Distance === 'number' ? { distance: hundredths(addr.Distance) } : {}),
      ...(distUnit ? { distanceUnit: distUnit } : {}),
      ...(poi.OperatorInfo?.Title ? { operator: poi.OperatorInfo.Title } : {}),
      ...(typeof poi.OperatorID === 'number' ? { operatorId: poi.OperatorID } : {}),
      ...(usage?.Title ? { usageType: usage.Title } : {}),
      // 0 is OCM's "(Unknown)" usage type — a real ID the usagetypeid filter takes, so it is kept.
      ...(typeof usage?.ID === 'number'
        ? { usageTypeId: usage.ID }
        : typeof poi.UsageTypeID === 'number'
          ? { usageTypeId: poi.UsageTypeID }
          : {}),
      ...(poi.UsageCost?.trim() ? { usageCost: poi.UsageCost.trim() } : {}),
      ...(typeof usage?.IsPayAtLocation === 'boolean'
        ? { isPayAtLocation: usage.IsPayAtLocation }
        : {}),
      ...(typeof usage?.IsMembershipRequired === 'boolean'
        ? { isMembershipRequired: usage.IsMembershipRequired }
        : {}),
      ...(typeof usage?.IsAccessKeyRequired === 'boolean'
        ? { isAccessKeyRequired: usage.IsAccessKeyRequired }
        : {}),
      ...(typeof poi.NumberOfPoints === 'number' ? { numberOfPoints: poi.NumberOfPoints } : {}),
      ...(status?.Title ? { status: status.Title } : {}),
      ...(typeof status?.ID === 'number'
        ? { statusTypeId: status.ID }
        : typeof poi.StatusTypeID === 'number'
          ? { statusTypeId: poi.StatusTypeID }
          : {}),
      // IsOperational is ABSENT for Unknown (ID 0) — only set when the key is actually present.
      ...(typeof status?.IsOperational === 'boolean'
        ? { isOperational: status.IsOperational }
        : {}),
      ...(poi.DateLastVerified !== undefined ? { dateLastVerified: poi.DateLastVerified } : {}),
      ...(typeof poi.IsRecentlyVerified === 'boolean'
        ? { isRecentlyVerified: poi.IsRecentlyVerified }
        : {}),
      ...(poi.DataProvider?.Title ? { dataProvider: poi.DataProvider.Title } : {}),
      ...(typeof poi.DataProvider?.ID === 'number'
        ? { dataProviderId: poi.DataProvider.ID }
        : typeof poi.DataProviderID === 'number'
          ? { dataProviderId: poi.DataProviderID }
          : {}),
      ...(poi.DataProvider?.License?.trim()
        ? { dataProviderLicense: poi.DataProvider.License.trim() }
        : {}),
      ...(typeof poi.DataProvider?.IsOpenDataLicensed === 'boolean'
        ? { isOpenDataLicensed: poi.DataProvider.IsOpenDataLicensed }
        : {}),
    };

    // Backfill operator/usage/status titles from reference data when OCM left them off but gave an ID.
    if (!station.operator && typeof poi.OperatorID === 'number') {
      const label = ref.labelFor('operators', poi.OperatorID);
      if (label) station.operator = label;
    }
    return station;
  }

  private normalizeStationDetail(poi: RawPoi, includeComments: boolean): NormalizedStationDetail {
    const base = this.normalizeStation(poi);
    const detail: NormalizedStationDetail = {
      ...base,
      ...(poi.GeneralComments?.trim() ? { generalComments: poi.GeneralComments.trim() } : {}),
      ...this.normalizeContacts(poi),
      ...(poi.DateCreated?.trim() ? { dateCreated: poi.DateCreated.trim() } : {}),
      ...(poi.DataProvider?.WebsiteURL ? { dataProviderUrl: poi.DataProvider.WebsiteURL } : {}),
      ...(poi.DateLastStatusUpdate !== undefined
        ? { dateLastStatusUpdate: poi.DateLastStatusUpdate }
        : {}),
      ...(poi.SubmissionStatus?.Title ? { submissionStatus: poi.SubmissionStatus.Title } : {}),
    };

    const media = (poi.MediaItems ?? [])
      .filter((m): m is { ItemURL: string; Comment?: string | null } => Boolean(m?.ItemURL))
      .map((m) => ({ url: m.ItemURL, ...(m.Comment ? { comment: m.Comment } : {}) }));
    if (media.length > 0) detail.media = media;

    if (includeComments) {
      detail.comments = this.normalizeComments(poi.UserComments ?? []);
    }
    return detail;
  }

  /**
   * Every way to reach a person the record carries: the site's phones and link, and the operator's
   * website, phone, and fault-report address. All six are withheld when OCM flags the operator as a
   * private individual — a home owner sharing a charger, whose site phone is a household's.
   */
  private normalizeContacts(
    poi: RawPoi,
  ): Pick<
    NormalizedStationDetail,
    | 'contactPhone'
    | 'contactPhoneSecondary'
    | 'relatedUrl'
    | 'operatorWebsite'
    | 'operatorPhone'
    | 'operatorFaultReportEmail'
  > {
    if (poi.OperatorInfo?.IsPrivateIndividual === true) return {};
    const addr = poi.AddressInfo ?? {};
    const operator = poi.OperatorInfo ?? {};
    return {
      ...(addr.ContactTelephone1?.trim() ? { contactPhone: addr.ContactTelephone1.trim() } : {}),
      ...(addr.ContactTelephone2?.trim()
        ? { contactPhoneSecondary: addr.ContactTelephone2.trim() }
        : {}),
      ...(addr.RelatedURL?.trim() ? { relatedUrl: addr.RelatedURL.trim() } : {}),
      ...(operator.WebsiteURL?.trim() ? { operatorWebsite: operator.WebsiteURL.trim() } : {}),
      ...(operator.PhonePrimaryContact?.trim()
        ? { operatorPhone: operator.PhonePrimaryContact.trim() }
        : {}),
      ...(operator.FaultReportEmail?.trim()
        ? { operatorFaultReportEmail: operator.FaultReportEmail.trim() }
        : {}),
    };
  }

  private normalizeConnection(c: RawConnection): NormalizedConnection {
    return {
      ...(typeof c.StatusType?.ID === 'number'
        ? { statusTypeId: c.StatusType.ID }
        : typeof c.StatusTypeID === 'number'
          ? { statusTypeId: c.StatusTypeID }
          : {}),
      ...(c.StatusType?.Title ? { status: c.StatusType.Title } : {}),
      ...(typeof c.StatusType?.IsOperational === 'boolean'
        ? { isOperational: c.StatusType.IsOperational }
        : {}),
      ...(c.Comments?.trim() ? { notes: c.Comments.trim() } : {}),
      ...(typeof c.ConnectionTypeID === 'number' ? { connectionTypeId: c.ConnectionTypeID } : {}),
      ...(c.ConnectionType?.Title ? { connectionType: c.ConnectionType.Title } : {}),
      ...(c.Level?.Title ? { level: c.Level.Title } : {}),
      ...(typeof c.LevelID === 'number' ? { levelId: c.LevelID } : {}),
      ...(c.PowerKW !== undefined ? { powerKW: c.PowerKW } : {}),
      ...(c.CurrentType?.Title ? { currentType: c.CurrentType.Title } : {}),
      ...(c.Amps !== undefined ? { amps: c.Amps } : {}),
      ...(c.Voltage !== undefined ? { voltage: c.Voltage } : {}),
      ...(c.Quantity !== undefined ? { quantity: c.Quantity } : {}),
    };
  }

  /**
   * Normalize and sort comments newest-first. The check-in outcome is the charge-attempt result —
   * it carries the meaning on records where OCM leaves `Comment` null — so its title, ID, and
   * OCM's own positive/negative classification all come across.
   */
  private normalizeComments(raw: RawUserComment[]): NormalizedComment[] {
    return raw
      .map((c) => ({
        ...(c.UserName ? { user: c.UserName } : {}),
        ...(c.CommentType?.Title ? { commentType: c.CommentType.Title } : {}),
        ...(c.CheckinStatusType?.Title ? { checkinStatus: c.CheckinStatusType.Title } : {}),
        ...(typeof c.CheckinStatusType?.ID === 'number'
          ? { checkinStatusId: c.CheckinStatusType.ID }
          : typeof c.CheckinStatusTypeID === 'number'
            ? { checkinStatusId: c.CheckinStatusTypeID }
            : {}),
        ...(typeof c.CheckinStatusType?.IsPositive === 'boolean'
          ? { checkinStatusIsPositive: c.CheckinStatusType.IsPositive }
          : {}),
        ...(c.Comment ? { comment: c.Comment } : {}),
        ...(c.Rating !== undefined ? { rating: c.Rating } : {}),
        ...(c.RelatedURL ? { relatedUrl: c.RelatedURL } : {}),
        ...(c.DateCreated ? { dateCreated: c.DateCreated } : {}),
      }))
      .sort((a, b) => {
        const ta = a.dateCreated ? Date.parse(a.dateCreated) : 0;
        const tb = b.dateCreated ? Date.parse(b.dateCreated) : 0;
        return tb - ta;
      });
  }
}

// --- Init/accessor pattern ---

let _service: OpenChargeMapService | undefined;

/** Construct the OCM service. Registered in `createApp()`'s `setup()`. */
export function initOpenChargeMapService(serverConfig: ServerConfig): void {
  _service = new OpenChargeMapService(serverConfig);
}

/** Accessor for the initialized OCM service. */
export function getOpenChargeMapService(): OpenChargeMapService {
  if (!_service) {
    throw new Error(
      'OpenChargeMapService not initialized — call initOpenChargeMapService() in setup()',
    );
  }
  return _service;
}

/** Reset the singleton (test isolation only). */
export function resetOpenChargeMapService(): void {
  _service = undefined;
}
