/**
 * @fileoverview Open Charge Map service — HTTP client over the OCM `/v3/poi` endpoint with retry,
 * session-level result caching, and response normalization. Search uses `verbose=false`; single-
 * station detail uses `verbose=true` so `GeneralComments`/`UsageCost`/`NumberOfPoints`/`MediaItems`
 * are populated. Non-OK responses are translated to contract reasons (`auth_failed` for 401/403,
 * `upstream_unavailable` otherwise) so calling tools surface a stable `data.reason`.
 * @module services/openchargemap/openchargemap-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable, unauthorized } from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  type RequestContext,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { getReferenceDataService } from '@/services/reference-data/reference-data-service.js';
import type {
  NormalizedComment,
  NormalizedConnection,
  NormalizedStation,
  NormalizedStationDetail,
  RawConnection,
  RawPoi,
  RawUserComment,
  SearchPoiParams,
} from './types.js';

/** Result-cache TTL in seconds — station status drifts over minutes, not seconds. */
const CACHE_TTL_SECONDS = 600;

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
 * True when a raw POI carries usable coordinates. OCM stores some records at exactly 0,0 (a
 * placeholder that would otherwise surface as a false distance-0 match) and omits lat/lng on others
 * (which `normalizeStation` then defaults to 0,0). Both are unusable for a proximity search, so it
 * drops them — checked on the raw address, ahead of the `?? 0` default that erases the distinction.
 * A single-axis zero (equator or prime meridian) is a real location and survives.
 */
function hasUsableCoordinates(poi: RawPoi): boolean {
  const lat = poi.AddressInfo?.Latitude;
  const lng = poi.AddressInfo?.Longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  return !(lat === 0 && lng === 0);
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
   * Search POIs by radius or bounding box with optional filters (`verbose=false`).
   * Returns normalized stations ordered by distance. Cached per param set in `ctx.state`.
   */
  async searchPois(params: SearchPoiParams, ctx: Context): Promise<NormalizedStation[]> {
    const key = cacheKey('search', params);
    const cached = await ctx.state.get<NormalizedStation[]>(key);
    if (cached) {
      ctx.log.debug('OCM search cache hit', { key });
      return cached;
    }

    const url = this.buildSearchUrl(params);
    const raw = await this.fetchPois(url, 'searchPois', ctx);
    // Search-only response filters (getPoi keeps everything): drop unusable-coordinate POIs on the
    // RAW address before normalization's `?? 0` erases the 0,0-vs-missing distinction, then honor the
    // minchargepoints contract locally since OCM's minnumberofpoints param is inert.
    const stations = raw
      .filter(hasUsableCoordinates)
      .map((poi) => this.normalizeStation(poi))
      .filter((station) => meetsMinChargePoints(station, params.minchargepoints));
    await ctx.state.set(key, stations, { ttl: CACHE_TTL_SECONDS });
    return stations;
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

  private buildSearchUrl(params: SearchPoiParams): string {
    const qs = new URLSearchParams({
      output: 'json',
      compact: 'false',
      verbose: 'false',
      maxresults: String(params.maxresults),
    });

    if (params.boundingbox) {
      const { sw_lat, sw_lng, ne_lat, ne_lng } = params.boundingbox;
      qs.set('boundingbox', `(${sw_lat},${sw_lng}),(${ne_lat},${ne_lng})`);
    } else if (params.latitude !== undefined && params.longitude !== undefined) {
      qs.set('latitude', String(params.latitude));
      qs.set('longitude', String(params.longitude));
      qs.set('distance', String(params.distance ?? 25));
      qs.set('distanceunit', params.distanceUnit ?? 'KM');
    }

    if (params.countrycode) qs.set('countrycode', params.countrycode.toUpperCase());
    if (params.minpowerkw !== undefined) qs.set('minpowerkw', String(params.minpowerkw));
    if (params.minchargepoints !== undefined)
      qs.set('minnumberofpoints', String(params.minchargepoints));

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

  /** Fetch and parse a POI array, with retry over the full pipeline and status→reason mapping. */
  private fetchPois(url: string, operation: string, ctx: Context): Promise<RawPoi[]> {
    const reqCtx: RequestContext = requestContextService.createRequestContext({
      operation,
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId, tenantId: ctx.tenantId },
    });
    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, 15_000, reqCtx, {
            headers: { 'X-API-Key': this.serverConfig.apiKey },
            signal: ctx.signal,
          });
        } catch (error) {
          throw this.translateFetchError(error, ctx);
        }
        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          throw this.malformedResponse(
            'Open Charge Map returned a body that is not valid JSON.',
            ctx,
            error,
          );
        }
        if (!Array.isArray(data)) {
          throw this.malformedResponse(
            'Open Charge Map returned an unexpected (non-array) response.',
            ctx,
          );
        }
        if (!data.every(isPoiRecord)) {
          throw this.malformedResponse(
            'Open Charge Map returned a station list containing an unreadable entry.',
            ctx,
          );
        }
        return data;
      },
      { operation, context: reqCtx, baseDelayMs: 1500, signal: ctx.signal },
    );
  }

  /**
   * One envelope for every unreadable response body — invalid JSON, a non-array payload, or an
   * array carrying an unreadable entry. All three are the same client-facing failure as a non-2xx
   * (OCM did not return usable data), so they carry the declared `upstream_unavailable` reason and
   * stay retryable rather than surfacing as a raw parser exception.
   */
  private malformedResponse(message: string, ctx: Context, cause?: unknown): Error {
    return serviceUnavailable(
      message,
      {
        reason: 'upstream_unavailable',
        retryable: true,
        ...ctx.recoveryFor('upstream_unavailable'),
      },
      { cause },
    );
  }

  /**
   * `fetchWithTimeout` throws a classified `McpError` on non-OK. Re-tag auth failures (401/403,
   * which OCM returns for a missing/invalid key) as `auth_failed`/Unauthorized (non-retryable);
   * everything else as `upstream_unavailable`/ServiceUnavailable (retryable) so the retry predicate
   * and the tool contracts align.
   */
  private translateFetchError(error: unknown, ctx: Context): Error {
    const code = (error as { code?: number }).code;
    if (code === JsonRpcErrorCode.Unauthorized || code === JsonRpcErrorCode.Forbidden) {
      return unauthorized('Open Charge Map rejected the API key (HTTP 401/403).', {
        reason: 'auth_failed',
        retryable: false,
        ...ctx.recoveryFor('auth_failed'),
      });
    }
    return serviceUnavailable(
      error instanceof Error ? error.message : 'Open Charge Map request failed.',
      {
        reason: 'upstream_unavailable',
        retryable: true,
        ...ctx.recoveryFor('upstream_unavailable'),
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
        ...(addr.Town ? { town: addr.Town } : {}),
        ...(addr.StateOrProvince ? { stateOrProvince: addr.StateOrProvince } : {}),
        ...(addr.Postcode ? { postcode: addr.Postcode } : {}),
        ...(addr.Country?.Title ? { country: addr.Country.Title } : {}),
        ...(addr.Country?.ISOCode ? { countryCode: addr.Country.ISOCode } : {}),
        ...(addr.AccessComments ? { accessComments: addr.AccessComments } : {}),
      },
      connections: (poi.Connections ?? []).map((c) => this.normalizeConnection(c)),
      ...(typeof addr.Distance === 'number' ? { distance: addr.Distance } : {}),
      ...(distUnit ? { distanceUnit: distUnit } : {}),
      ...(poi.OperatorInfo?.Title ? { operator: poi.OperatorInfo.Title } : {}),
      ...(typeof poi.OperatorID === 'number' ? { operatorId: poi.OperatorID } : {}),
      ...(usage?.Title ? { usageType: usage.Title } : {}),
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
      ...(poi.UsageCost?.trim() ? { usageCost: poi.UsageCost.trim() } : {}),
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

  private normalizeConnection(c: RawConnection): NormalizedConnection {
    return {
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
