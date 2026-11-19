/**
 * @fileoverview Tests for OpenChargeMapService at the service boundary — focused on the cache-key
 * contract. The framework's StorageService rejects any key outside `/^[a-zA-Z0-9_.\-/]+$/` (colons,
 * `?`, `=`, `&` are invalid). `createMockContext` now runs that same validator, so a malformed key
 * throws in a handler test too — but as a generic storage rejection from wherever it happened to be
 * written. These tests capture the exact keys the service passes to `ctx.state` and assert them
 * against the pattern directly, so a regression names the offending key instead of a caller.
 * @module tests/services/openchargemap-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { httpStatusToErrorCode } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DistanceUnit, SearchLocation } from '@/services/openchargemap/types.js';

const fetchWithTimeout = vi.fn();

/** `withRetry` runs one attempt unless a suite that tests the retry ladder itself sets `real`. */
const retry = { real: false };

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    withRetry: (...args: Parameters<typeof actual.withRetry>) =>
      retry.real
        ? actual.withRetry(...args)
        : args[0]({ signal: new AbortController().signal, remainingMs: Number.POSITIVE_INFINITY }),
  };
});

const { OpenChargeMapService } = await import('@/services/openchargemap/openchargemap-service.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const {
  BLANK_COMMENTS_POI,
  CONTACT_POI_DETAIL,
  FULL_POI,
  FULL_POI_DETAIL,
  LONDON_POI,
  PRIVATE_POI_DETAIL,
  SEATTLE_PORTLAND_ROUTE,
  SEATTLE_PORTLAND_ROWS,
  SPARSE_POI,
  ZERO_COORD_POI,
  jsonResponse,
  routePoi,
} = await import('../fixtures/ocm.js');

/** The framework's storage-key validator (`storageValidation.ts`): only these characters are legal. */
const VALID_KEY_PATTERN = /^[a-zA-Z0-9_.\-/]+$/;

const serverConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};

beforeEach(async () => {
  fetchWithTimeout.mockReset();
  await initReferenceDataService(serverConfig);
});

afterEach(() => vi.clearAllMocks());

/** A mock context whose `state.get`/`state.set` calls are spied so we can inspect the keys used. */
function spiedCtx() {
  const ctx = createMockContext({ tenantId: 'test' });
  const getSpy = vi.spyOn(ctx.state, 'get');
  const setSpy = vi.spyOn(ctx.state, 'set');
  return { ctx, getSpy, setSpy };
}

/** A radius search around a point, 25 KM unless stated — the location a center search hands the service. */
function near(
  latitude: number,
  longitude: number,
  distance = 25,
  distanceUnit: DistanceUnit = 'KM',
): SearchLocation {
  return { mode: 'radius', latitude, longitude, distance, distanceUnit };
}

describe('OpenChargeMapService cache keys are storage-safe', () => {
  it('searchPois uses a key the framework storage validator accepts (no colons)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx, getSpy, setSpy } = spiedCtx();

    await svc.searchPois({ location: near(47.6, -122.3, 5) }, ctx);

    const getKey = getSpy.mock.calls[0]![0] as string;
    const setKey = setSpy.mock.calls[0]![0] as string;
    expect(getKey).toMatch(VALID_KEY_PATTERN);
    expect(setKey).toMatch(VALID_KEY_PATTERN);
    expect(getKey).toBe(setKey); // read and write address the same cache slot
    expect(getKey).not.toContain(':');
  });

  it('getPoi uses a key the framework storage validator accepts (no colons)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx, getSpy, setSpy } = spiedCtx();

    await svc.getPoi(145452, { includeComments: true }, ctx);

    const getKey = getSpy.mock.calls[0]![0] as string;
    const setKey = setSpy.mock.calls[0]![0] as string;
    expect(getKey).toMatch(VALID_KEY_PATTERN);
    expect(setKey).toMatch(VALID_KEY_PATTERN);
    expect(getKey).toBe(setKey);
    expect(getKey).not.toContain(':');
  });

  it('distinct search params produce distinct cache keys', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);

    const { ctx: c1, setSpy: s1 } = spiedCtx();
    await svc.searchPois({ location: near(47.6, -122.3, 5) }, c1);
    const { ctx: c2, setSpy: s2 } = spiedCtx();
    await svc.searchPois({ location: near(51.5, -0.12, 5) }, c2);

    expect(s1.mock.calls[0]![0]).not.toBe(s2.mock.calls[0]![0]);
  });

  it('caches the empty-result sentinel and returns null without a second fetch', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();

    const first = await svc.getPoi(99999991, { includeComments: false }, ctx);
    const second = await svc.getPoi(99999991, { includeComments: false }, ctx);

    expect(first).toBeNull();
    expect(second).toBeNull();
    // Second call served from the cached 'EMPTY' sentinel — only one upstream fetch.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('OpenChargeMapService boundary behavior', () => {
  it('keeps one fixed pool across deep windows and excludes the sentinel from normalization', async () => {
    const pool = Array.from({ length: 500 }, (_, i) => ({ ...FULL_POI, ID: i + 1 }));
    fetchWithTimeout.mockResolvedValue(jsonResponse([...pool, { ...FULL_POI, ID: 999 }]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx, setSpy } = spiedCtx();
    // The service returns the whole pool; every caller window is a slice the tool cuts from it.
    for (let call = 0; call < 4; call += 1) {
      const result = await svc.searchPois({ location: near(47.6, -122.3) }, ctx);
      expect(result).toMatchObject({ candidateCap: 500, fetched: 500, moreUpstream: true });
      expect(result.matches.map((station) => station.id)).toEqual(
        pool.map((station) => station.ID),
      );
    }
    expect(fetchWithTimeout).toHaveBeenCalledOnce();
    expect(new URL(String(fetchWithTimeout.mock.calls[0]![0])).searchParams.get('maxresults')).toBe(
      '501',
    );
    expect(setSpy).toHaveBeenCalledOnce();
    expect(setSpy.mock.calls[0]![2]).toEqual({ ttl: 600 });
  });

  it('distinguishes exactly exhausted pools from a sentinel even when local filters empty them', async () => {
    const svc = new OpenChargeMapService(serverConfig);
    for (const size of [500, 501]) {
      fetchWithTimeout.mockResolvedValue(
        jsonResponse(Array.from({ length: size }, () => ZERO_COORD_POI)),
      );
      const result = await svc.searchPois({ location: near(47.6, -122.3) }, spiedCtx().ctx);
      expect(result).toMatchObject({ fetched: 500, moreUpstream: size === 501, matches: [] });
    }
  });

  it('serializes every supported search filter at the OCM boundary', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();

    await svc.searchPois(
      {
        location: near(47.6, -122.3, 500, 'Miles'),
        countrycode: 'us',
        connectiontypeid: [32, 33],
        minpowerkw: 50,
        operatorid: [5, 23],
        usagetypeid: 1,
        levelid: 3,
        statustypeid: [30, 50],
        minchargepoints: 4,
      },
      ctx,
    );

    const url = new URL(String(fetchWithTimeout.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      latitude: '47.6',
      longitude: '-122.3',
      /**
       * Open Charge Map reports distances on a 3,959-mile sphere but draws its search circle on
       * MongoDB's 6,378.1 km one, converting miles at 0.621371192 per km. 500 miles is the angle
       * 500 / 3959, which that circle reaches at 500 / 3959 × 6378.1 × 0.621371192 = 500.52634 miles:
       * sent rounded up to three decimals (500.527), plus 0.001 (500.528).
       */
      distance: '500.528',
      distanceunit: 'Miles',
      countrycode: 'US',
      connectiontypeid: '32,33',
      minpowerkw: '50',
      operatorid: '5,23',
      usagetypeid: '1',
      levelid: '3',
      statustypeid: '30,50',
    });
    // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
    // minnumberofpoints is inert upstream; meetsMinChargePoints carries the contract instead.
    expect(url.searchParams.has('minnumberofpoints')).toBe(false);
    // maxresults is the service's own candidate page, never the caller's window.
    expect(url.searchParams.get('maxresults')).toBe('501');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('sizes the upstream page above the caller window so local filters have candidates to spare', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);

    // No caller window reaches the service, so the cap is the same 500 + 1 in every location mode.
    for (const location of [
      near(47.6, -122.3),
      {
        mode: 'box',
        box: { sw_lat: 47.4, sw_lng: -122.5, ne_lat: 47.8, ne_lng: -122.1 },
        distanceUnit: 'KM',
      },
    ] satisfies SearchLocation[]) {
      fetchWithTimeout.mockClear();
      await svc.searchPois({ location }, spiedCtx().ctx);
      const url = new URL(String(fetchWithTimeout.mock.calls[0]![0]));
      expect(url.searchParams.get('maxresults')).toBe('501');
    }
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('serves every window over one search from a single upstream fetch', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI, SPARSE_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();

    // The same search three times: every caller window is a slice of the one cached pool.
    for (let call = 0; call < 3; call += 1) {
      await svc.searchPois({ location: near(47.6, -122.3) }, ctx);
    }

    expect(fetchWithTimeout).toHaveBeenCalledOnce();
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  // The raw fetched count survives local filtering, so the caller can tell an empty search area
  // apart from a candidate page the filters emptied.
  it('reports what upstream returned even when local filtering drops every record', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([ZERO_COORD_POI, { ...FULL_POI, ID: 2 }]));
    const svc = new OpenChargeMapService(serverConfig);

    const result = await svc.searchPois(
      { location: near(47.6, -122.3), minchargepoints: 999 },
      spiedCtx().ctx,
    );

    expect(result).toMatchObject({ candidateCap: 500, fetched: 2 });
    expect(result.matches).toEqual([]);
  });

  it('normalizes full and sparse station records without fabricating optional facts', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI, SPARSE_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { matches } = await svc.searchPois({ location: near(47.6, -122.3) }, spiedCtx().ctx);

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      id: 145452,
      operator: 'ChargePoint',
      distanceUnit: 'KM',
      isPayAtLocation: false,
    });
    expect(matches[1]).toMatchObject({ id: 253415, connections: [{ powerKW: null }] });
    expect(matches[1]!.operator).toBeUndefined();
    expect(matches[1]!.isOperational).toBeUndefined();
  });

  it('serves repeated searches from the tenant cache', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();
    const params = { location: near(47.6, -122.3) };

    const first = await svc.searchPois(params, ctx);
    const second = await svc.searchPois(params, ctx);

    expect(second).toEqual(first);
    expect(fetchWithTimeout).toHaveBeenCalledOnce();
  });

  it('normalizes detail-only fields and excludes comments unless requested', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(145452, { includeComments: false }, spiedCtx().ctx);

    expect(detail).toMatchObject({
      id: 145452,
      generalComments: 'Located in the parking garage, level P1.',
      usageCost: '$0.30/kWh',
      media: [{ url: 'https://example.com/photo.jpg', comment: 'Entrance' }],
    });
    expect(detail?.comments).toBeUndefined();
  });

  it('normalizes and sorts requested comments newest-first', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(145452, { includeComments: true }, spiedCtx().ctx);

    expect(detail?.comments).toHaveLength(2);
    expect(detail?.comments?.map((comment) => comment.dateCreated)).toEqual([
      '2025-06-01T10:00:00Z',
      '2025-05-01T10:00:00Z',
    ]);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('carries the check-in outcome, its id, its polarity, and the related link', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(145452, { includeComments: true }, spiedCtx().ctx);

    expect(detail?.comments?.[0]).toMatchObject({
      checkinStatus: 'Failed to Charge (Equipment Not Operational)',
      checkinStatusId: 20,
      checkinStatusIsPositive: false,
      relatedUrl: 'https://example.com/outage',
    });
    expect(detail?.comments?.[1]).toMatchObject({
      checkinStatus: 'Charged Successfully',
      checkinStatusIsPositive: true,
    });
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('leaves check-in fields absent when OCM records no outcome', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([BLANK_COMMENTS_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(71749, { includeComments: true }, spiedCtx().ctx);

    expect(detail?.comments).toHaveLength(3);
    expect(detail?.comments?.[0]).not.toHaveProperty('checkinStatus');
    expect(detail?.comments?.[0]).not.toHaveProperty('checkinStatusIsPositive');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('normalizes the status id from the nested object and from the bare StatusTypeID', async () => {
    const svc = new OpenChargeMapService(serverConfig);

    // The bare ID disagrees with the nested object, so only the nested arm can produce 30.
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse([{ ...FULL_POI, StatusTypeID: 210 }]));
    const nested = await svc.searchPois({ location: near(47.6, -122.3) }, spiedCtx().ctx);
    expect(nested.matches[0]?.statusTypeId).toBe(30);
    expect(nested.matches[0]?.isOperational).toBe(true); // upstream flag untouched

    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([{ ...FULL_POI, StatusType: null, StatusTypeID: 100 }]),
    );
    const bare = await svc.searchPois({ location: near(1, 1) }, spiedCtx().ctx);
    expect(bare.matches[0]?.statusTypeId).toBe(100);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('leaves statusTypeId absent when OCM has no status on record', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([SPARSE_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(253415, { includeComments: false }, spiedCtx().ctx);

    expect(detail).not.toHaveProperty('statusTypeId');
    expect(detail).not.toHaveProperty('isOperational');
  });

  it('maps a non-array upstream body to a service-unavailable error envelope', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse({ error: 'bad gateway body' }));
    const svc = new OpenChargeMapService(serverConfig);

    await expect(
      svc.searchPois({ location: near(47.6, -122.3) }, spiedCtx().ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
  });

  it('preserves an empty array as a valid empty upstream result', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const svc = new OpenChargeMapService(serverConfig);

    await expect(
      svc.searchPois({ location: near(47.6, -122.3) }, spiedCtx().ctx),
    ).resolves.toMatchObject({ fetched: 0, matches: [] });
  });

  it('maps both HTTP 401 and 403 boundary failures to auth_failed', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const svc = new OpenChargeMapService(serverConfig);

    for (const code of [JsonRpcErrorCode.Unauthorized, JsonRpcErrorCode.Forbidden]) {
      fetchWithTimeout.mockRejectedValueOnce(new McpError(code, `HTTP ${code}`));
      await expect(
        svc.searchPois({ location: near(47.6, -122.3) }, spiedCtx().ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'auth_failed', retryable: false },
      });
    }
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('over-fetches before applying local minchargepoints filters', async () => {
    const belowMinimum = { ...FULL_POI, ID: 1, NumberOfPoints: 1 };
    const matching = { ...FULL_POI, ID: 2, NumberOfPoints: 8 };
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      return Promise.resolve(jsonResponse(cap === 1 ? [belowMinimum] : [belowMinimum, matching]));
    });
    const svc = new OpenChargeMapService(serverConfig);

    const result = await svc.searchPois(
      { location: near(47.6, -122.3), minchargepoints: 6 },
      spiedCtx().ctx,
    );
    expect(result.matches.map((station) => station.id)).toEqual([2]);
  });
});

/**
 * The error `fetchWithTimeout` throws for a non-2xx response: the code the framework maps the status
 * to, the status on `data`, and the `retryable: false` it adds for a 501.
 */
function httpFailure(status: number): InstanceType<typeof McpError> {
  return new McpError(
    httpStatusToErrorCode(status) ?? JsonRpcErrorCode.InternalError,
    `Fetch failed for https://api.openchargemap.io/v3/poi. Status: ${status}`,
    { status, statusText: 'Upstream status', ...(status === 501 ? { retryable: false } : {}) },
  );
}

// The fetch is the seam: the real retry ladder runs over it on fake time, and each call is one attempt.
describe('OpenChargeMapService retry classification at the fetch seam', () => {
  beforeEach(() => {
    retry.real = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    retry.real = false;
    vi.useRealTimers();
  });

  /**
   * Run a detail fetch, or a search of `location`, to its failure on fake time: what it threw, how
   * many attempts, how long.
   */
  async function settle(location?: SearchLocation) {
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();
    const startedAt = Date.now();
    const call = location
      ? svc.searchPois({ location }, ctx)
      : svc.getPoi(145452, { includeComments: false }, ctx);
    const outcome = call.then(
      () => {
        throw new Error('Expected the fetch to fail, but it returned.');
      },
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    const error = await outcome;
    if (!(error instanceof McpError)) throw error;
    return {
      error,
      attempts: fetchWithTimeout.mock.calls.length,
      elapsedMs: Date.now() - startedAt,
    };
  }

  it.each([500, 502, 503, 504, 408, 429])(
    'retries a transient HTTP %i and reports it as retryable',
    async (status) => {
      fetchWithTimeout.mockRejectedValue(httpFailure(status));
      const { error, attempts } = await settle();

      expect(attempts).toBe(4);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
      // The tool's declared recovery (retry later) applies, so no throw-site hint overrides it.
      expect(error.data).not.toHaveProperty('recovery');
    },
  );

  it('retries a network failure that never produced a response', async () => {
    fetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Network error during fetch', {
        errorSource: 'FetchNetworkErrorWrapper',
      }),
    );
    const { error, attempts } = await settle();

    expect(attempts).toBe(4);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
  });

  it.each([400, 404, 405, 414, 422, 501])(
    'fails a permanent HTTP %i once, as not retryable, without promising a retry',
    async (status) => {
      fetchWithTimeout.mockRejectedValue(httpFailure(status));
      const { error, attempts, elapsedMs } = await settle();

      expect(attempts).toBe(1);
      expect(elapsedMs).toBe(0);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: false },
      });
      const hint = (error.data?.recovery as { hint?: unknown } | undefined)?.hint;
      expect(hint).toEqual(expect.stringContaining(`HTTP ${status}`));
      expect(hint).not.toMatch(/retry after|try again|short delay/i);
    },
  );

  it.each([401, 403])('fails an HTTP %i once as auth_failed', async (status) => {
    fetchWithTimeout.mockRejectedValue(httpFailure(status));
    const { error, attempts } = await settle();

    expect(attempts).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'auth_failed', retryable: false },
    });
  });

  it('carries a caller cancellation through untouched and never retries it', async () => {
    fetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.RequestCancelled, 'Fetch was aborted.', {
        errorSource: 'FetchAborted',
      }),
    );
    const { error, attempts } = await settle();

    expect(attempts).toBe(1);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data).not.toHaveProperty('reason');
  });

  /** Every attempt runs to the 15 s per-request timeout, as fetchWithTimeout does against a hang. */
  function hangEveryAttempt() {
    fetchWithTimeout.mockImplementation(
      (_url: string, timeoutMs: number) =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new McpError(JsonRpcErrorCode.Timeout, 'Fetch timed out.', {
                  errorSource: 'FetchTimeout',
                }),
              ),
            timeoutMs,
          );
        }),
    );
  }

  it('settles a hung upstream as retryable upstream_unavailable before a 60 s client gives up', async () => {
    hangEveryAttempt();
    const { error, elapsedMs } = await settle();

    expect(elapsedMs).toBeLessThan(60_000);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
  });

  it.each([
    ['radius', near(47.6, -122.3)],
    [
      'box',
      {
        mode: 'box',
        box: { sw_lat: 47.4, sw_lng: -122.5, ne_lat: 47.8, ne_lng: -122.1 },
        distanceUnit: 'KM',
      },
    ],
  ] satisfies [string, SearchLocation][])(
    'retries a %s search whose attempts run out the request timeout',
    async (_mode, location) => {
      hangEveryAttempt();
      const { error, attempts } = await settle(location);

      expect(attempts).toBeGreaterThan(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
      expect(error.data).not.toHaveProperty('recovery');
    },
  );

  it('fails a route search that runs out the request timeout at once, not retryable, with its next move', async () => {
    hangEveryAttempt();
    const { error, attempts, elapsedMs } = await settle(along(SEATTLE_PORTLAND_ROUTE));

    expect(attempts).toBe(1);
    expect(elapsedMs).toBe(15_000);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: false },
    });
    expect(error.message).toBe(
      'Open Charge Map did not answer this route search within the 15 s request timeout.',
    );
    const hint = (error.data?.recovery as { hint?: unknown } | undefined)?.hint;
    expect(hint).toBe(
      'Send the route with fewer points, or search a stretch of it with a center or a boundingbox.',
    );
  });

  it.each([
    ['an HTTP 504', () => fetchWithTimeout.mockRejectedValue(httpFailure(504))],
    [
      'a network failure',
      () =>
        fetchWithTimeout.mockRejectedValue(
          new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Network error during fetch', {
            errorSource: 'FetchNetworkErrorWrapper',
          }),
        ),
    ],
  ])('still retries a route search on %s', async (_failure, fail) => {
    fail();
    const { error, attempts } = await settle(along(SEATTLE_PORTLAND_ROUTE));

    expect(attempts).toBe(4);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
    expect(error.data).not.toHaveProperty('recovery');
  });

  /**
   * The framework's own `fetchWithTimeout` over a stubbed global `fetch`, so the `Retry-After` header
   * capture and the deadline that follows a 2xx body into `response.json()` run as in production.
   * The stub's body errors when the request signal aborts, as a real fetch body does.
   */
  describe('through the real fetchWithTimeout', () => {
    const encode = (text: string) => new TextEncoder().encode(text);

    async function routeFetch(respond: (init: RequestInit) => Response) {
      const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
        '@cyanheads/mcp-ts-core/utils',
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => respond(init)),
      );
      fetchWithTimeout.mockImplementation((...args: Parameters<typeof actual.fetchWithTimeout>) =>
        actual.fetchWithTimeout(...args),
      );
    }

    /** Like `settle`, but timed when the failure lands rather than after every timer has run. */
    async function settleWith(signal?: AbortSignal, location?: SearchLocation) {
      const svc = new OpenChargeMapService(serverConfig);
      const ctx = createMockContext({ tenantId: 'test', ...(signal ? { signal } : {}) });
      const startedAt = Date.now();
      let failedAt = Number.NaN;
      const call = location
        ? svc.searchPois({ location }, ctx)
        : svc.getPoi(145452, { includeComments: false }, ctx);
      const outcome = call.then(
        () => {
          throw new Error('Expected the fetch to fail, but it returned.');
        },
        (error: unknown) => {
          failedAt = Date.now();
          return error;
        },
      );
      await vi.runAllTimersAsync();
      const error = await outcome;
      if (!(error instanceof McpError)) throw error;
      return {
        error,
        attempts: fetchWithTimeout.mock.calls.length,
        elapsedMs: failedAt - startedAt,
      };
    }

    afterEach(() => vi.unstubAllGlobals());

    it('waits out the Retry-After a transient failure names and hands it to the caller', async () => {
      await routeFetch(
        () => new Response('busy', { status: 503, headers: { 'Retry-After': '5' } }),
      );
      const { error, attempts, elapsedMs } = await settleWith();

      expect(attempts).toBe(4);
      expect(elapsedMs).toBe(15_000); // three waits of exactly 5 s, not jittered exponential backoff
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true, retryAfter: '5' },
      });
    });

    it('fails at once when the Retry-After outlasts the retry ladder, keeping the wait', async () => {
      await routeFetch(
        () => new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }),
      );
      const { error, attempts, elapsedMs } = await settleWith();

      expect(attempts).toBe(1);
      expect(elapsedMs).toBe(0);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true, retryAfter: '120' },
      });
    });

    it('settles within the deadline when honored Retry-After waits leave an attempt hanging', async () => {
      const retryAfter = ['20', '28'];
      await routeFetch((init) => {
        const wait = retryAfter.shift();
        if (wait) return new Response('busy', { status: 429, headers: { 'Retry-After': wait } });
        // A hung upstream: the attempt ends only when its signal aborts.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }) as unknown as Response;
      });
      const { error, attempts, elapsedMs } = await settleWith();

      expect(attempts).toBe(3);
      expect(elapsedMs).toBeLessThanOrEqual(50_000); // the whole ladder's deadline, under a 60 s client
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
    });

    it('carries a caller cancellation during the body read through untouched', async () => {
      const caller = new AbortController();
      await routeFetch(
        (init) =>
          new Response(
            new ReadableStream({
              start(body) {
                body.enqueue(encode('[{"ID":1,'));
                init.signal?.addEventListener('abort', () => body.error(init.signal?.reason), {
                  once: true,
                });
              },
              pull() {
                // The caller goes away once the first chunk has been read.
                caller.abort();
                return new Promise(() => {});
              },
            }),
            { status: 200 },
          ),
      );
      const { error, attempts } = await settleWith(caller.signal);

      expect(attempts).toBe(1);
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.data).not.toHaveProperty('reason');
    });

    it('fails a route search whose body runs out the request timeout at once, not retryable', async () => {
      await routeFetch(
        (init) =>
          new Response(
            new ReadableStream({
              start(body) {
                body.enqueue(encode('[{"ID":1,'));
                init.signal?.addEventListener('abort', () => body.error(init.signal?.reason), {
                  once: true,
                });
              },
              pull() {
                // The rest of the body never arrives.
                return new Promise(() => {});
              },
            }),
            { status: 200 },
          ),
      );
      const { error, attempts, elapsedMs } = await settleWith(
        undefined,
        along(SEATTLE_PORTLAND_ROUTE),
      );

      expect(attempts).toBe(1);
      expect(elapsedMs).toBe(15_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: false },
      });
    });

    it('reports a connection dropped mid-body as a network failure, not as unreadable JSON', async () => {
      await routeFetch(
        () =>
          new Response(
            new ReadableStream({
              start(body) {
                body.enqueue(encode('[{"ID":1,'));
              },
              pull(body) {
                body.error(new TypeError('socket hang up'));
              },
            }),
            { status: 200 },
          ),
      );
      const { error, attempts } = await settleWith();

      expect(attempts).toBe(4);
      expect(error.message).toMatch(/network error/i);
      expect(error.message).not.toMatch(/not valid JSON/);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true },
      });
    });

    it('still reports a 2xx body that is not JSON as unreadable', async () => {
      await routeFetch(() => new Response('<html>maintenance</html>', { status: 200 }));
      const { error, attempts } = await settleWith();

      expect(attempts).toBe(4);
      expect(error.message).toMatch(/not valid JSON/);
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
    });
  });
});

/** The six detail fields that reach a person: every phone, URL, and email the record can carry. */
const CONTACT_KEYS = [
  'contactPhone',
  'contactPhoneSecondary',
  'relatedUrl',
  'operatorWebsite',
  'operatorPhone',
  'operatorFaultReportEmail',
] as const;

// https://github.com/cyanheads/openchargemap-mcp-server/issues/38
// https://github.com/cyanheads/openchargemap-mcp-server/issues/39
describe('OpenChargeMapService station contact, usage, and provider fields', () => {
  it('carries address line 2, usage type ID, usage cost, and provider ID on search rows', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([LONDON_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { matches } = await svc.searchPois({ location: near(51.5, -0.1) }, spiedCtx().ctx);

    expect(matches[0]).toMatchObject({
      address: { line1: '19-25 Broadwick Street', line2: 'Soho' },
      usageTypeId: 6,
      usageCost: 'Free',
      dataProviderId: 1,
    });
    // Contact fields and the creation date belong to the detail record only.
    for (const key of [...CONTACT_KEYS, 'dateCreated']) expect(matches[0]).not.toHaveProperty(key);
  });

  it('keeps usage type ID 0, reads the bare IDs when the nested objects are missing, and trims cost', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        {
          ...LONDON_POI,
          UsageTypeID: 0,
          UsageType: { ID: 0, Title: '(Unknown)' },
          UsageCost: '  £0.79/kWh  ',
        },
        {
          ...LONDON_POI,
          // Both rows sit at the same distance, so the higher ID keeps this one second.
          ID: LONDON_POI.ID + 1,
          UsageType: null,
          UsageTypeID: 4,
          DataProvider: null,
          DataProviderID: 18,
        },
      ]),
    );
    const svc = new OpenChargeMapService(serverConfig);
    const { matches } = await svc.searchPois({ location: near(51.5, -0.1) }, spiedCtx().ctx);

    expect(matches[0]).toMatchObject({ usageTypeId: 0, usageCost: '£0.79/kWh' });
    expect(matches[1]).toMatchObject({ usageTypeId: 4, dataProviderId: 18 });
  });

  it('leaves every new field absent when OCM has none on record', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        {
          ...SPARSE_POI,
          UsageCost: '   ',
          AddressInfo: { ...SPARSE_POI.AddressInfo, AddressLine2: null },
        },
      ]),
    );
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(253415, { includeComments: false }, spiedCtx().ctx);

    for (const key of [
      'usageTypeId',
      'usageCost',
      'dataProviderId',
      'dateCreated',
      ...CONTACT_KEYS,
    ])
      expect(detail).not.toHaveProperty(key);
    expect(detail?.address).not.toHaveProperty('line2');
  });

  it('returns site and operator contact fields and the creation date on the detail record', async () => {
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse([CONTACT_POI_DETAIL]));
    const svc = new OpenChargeMapService(serverConfig);
    const evgo = await svc.getPoi(278317, { includeComments: false }, spiedCtx().ctx);

    expect(evgo).toMatchObject({
      contactPhone: '877-455-3833',
      relatedUrl: 'https://www.evgo.com/',
      operatorWebsite: 'https://www.evgo.com/',
      dateCreated: '2023-09-28T05:34:00Z',
      usageTypeId: 1,
      dataProviderId: 1,
    });
    expect(evgo).not.toHaveProperty('operatorPhone');
    expect(evgo).not.toHaveProperty('usageCost');

    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([
        {
          ...LONDON_POI,
          AddressInfo: {
            ...LONDON_POI.AddressInfo,
            ContactTelephone1: '020 1',
            ContactTelephone2: '020 2',
          },
        },
      ]),
    );
    const pod = await svc.getPoi(67840, { includeComments: false }, spiedCtx().ctx);
    expect(pod).toMatchObject({
      contactPhone: '020 1',
      contactPhoneSecondary: '020 2',
      operatorWebsite: 'http://www.pod-point.com/',
      operatorPhone: '020 7247 4114',
      operatorFaultReportEmail: 'enquiries@pod-point.com',
      usageCost: 'Free',
    });
  });

  it('omits every phone, URL, and email when the operator is a private individual', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([
        {
          ...PRIVATE_POI_DETAIL,
          // Populate the operator half too, so the rule is proven for both halves.
          OperatorInfo: {
            ...PRIVATE_POI_DETAIL.OperatorInfo,
            WebsiteURL: 'https://home.example/',
            PhonePrimaryContact: '555-0100',
            FaultReportEmail: 'owner@home.example',
          },
        },
      ]),
    );
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(496719, { includeComments: false }, spiedCtx().ctx);

    for (const key of CONTACT_KEYS) expect(detail).not.toHaveProperty(key);
    // Everything that is not a way to reach a person still comes through.
    expect(detail).toMatchObject({
      operator: '(Private Residence/Individual)',
      operatorId: 44,
      usageTypeId: 5,
      usageCost: '$.30 per KWh, plus $5 per hour idle fee',
      dateCreated: '2026-03-02T17:21:00Z',
    });
  });

  it('keeps contact fields when the private-individual flag is false or absent', async () => {
    const { IsPrivateIndividual: _flag, ...unflagged } = CONTACT_POI_DETAIL.OperatorInfo;
    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([{ ...CONTACT_POI_DETAIL, OperatorInfo: unflagged }]),
    );
    const svc = new OpenChargeMapService(serverConfig);
    const detail = await svc.getPoi(278317, { includeComments: false }, spiedCtx().ctx);

    expect(detail).toMatchObject({
      contactPhone: '877-455-3833',
      relatedUrl: 'https://www.evgo.com/',
    });
  });
});

/** A route search, 5 KM either side unless stated. */
function along(
  route: { latitude: number; longitude: number }[],
  distance = 5,
  distanceUnit: DistanceUnit = 'KM',
): SearchLocation {
  return { mode: 'route', route, distance, distanceUnit };
}

/** The query of the n-th upstream request. */
function sentQuery(call = 0): URLSearchParams {
  return new URL(String(fetchWithTimeout.mock.calls[call]![0])).searchParams;
}

/** Run a search that must throw, and return what it threw. */
async function rejection(run: () => Promise<unknown>): Promise<McpErrorShape> {
  try {
    await run();
  } catch (error) {
    return error as McpErrorShape;
  }
  throw new Error('Expected the search to throw, but it returned.');
}

interface McpErrorShape {
  code: number;
  data?: { reason?: string; recovery?: { hint?: string } };
  message: string;
}

const seattlePortlandPool = () =>
  SEATTLE_PORTLAND_ROWS.map((row) => routePoi(row.id, row.latitude, row.longitude));

// https://github.com/cyanheads/openchargemap-mcp-server/issues/37
describe('OpenChargeMapService route search', () => {
  it('sends a polyline in km with a widened distance and no center or box', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const svc = new OpenChargeMapService(serverConfig);
    await svc.searchPois(
      { location: along(SEATTLE_PORTLAND_ROUTE), countrycode: 'us', levelid: 3 },
      spiedCtx().ctx,
    );

    const sent = sentQuery();
    expect(sent.get('polyline')).toBe('waqaHr~siVz~mBv`nBbvnDjiFvtxBwvq@');
    expect(sent.get('distanceunit')).toBe('KM');
    // Wider than 5 km of longitude at the route's top (13.35 km), by no more than the corner-chord and
    // simplification margins the corridor needs (tests/services/route-geometry.test.ts).
    expect(Number(sent.get('distance'))).toBeGreaterThan(13.35);
    expect(Number(sent.get('distance'))).toBeLessThan(14.2);
    for (const absent of ['latitude', 'longitude', 'boundingbox']) {
      expect(sent.has(absent)).toBe(false);
    }
    expect(sent.get('countrycode')).toBe('US');
    expect(sent.get('levelid')).toBe('3');
    expect(sent.get('maxresults')).toBe('501');
  });

  it('keeps the stations within the corridor, in the order the route meets them', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(seattlePortlandPool()));
    const svc = new OpenChargeMapService(serverConfig);
    const result = await svc.searchPois(
      { location: along(SEATTLE_PORTLAND_ROUTE) },
      spiedCtx().ctx,
    );

    // Open Charge Map sent them newest first; the three over 5 km off the route are gone.
    expect(result.matches.map((s) => s.id)).toEqual([
      380340, 380023, 379328, 379255, 249426, 233151, 376026, 6628,
    ]);
    expect(result).toMatchObject({ fetched: 11, moreUpstream: false });
    expect(result).not.toHaveProperty('reach');
    expect(result.area).toMatchObject({ mode: 'route', distance: 5, distanceUnit: 'KM' });
    expect((result.area as { length: number }).length).toBeCloseTo(248.58, 2);
    for (const station of result.matches) {
      const row = SEATTLE_PORTLAND_ROWS.find((r) => r.id === station.id)!;
      expect(station.distanceUnit).toBe('KM');
      expect(station).not.toHaveProperty('distance');
      expect(station.offRouteDistance).toBeLessThanOrEqual(5);
      expect(Math.abs(station.offRouteDistance! - row.off)).toBeLessThan(0.07);
    }
    const positions = result.matches.map((s) => s.routeDistance!);
    expect(positions[0]).toBe(0); // north of the first point: met at the start
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.at(-1)).toBeCloseTo(248.58, 2); // Portland, at the last point
  });

  it('reports the corridor positions in miles for a corridor given in miles', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(seattlePortlandPool()));
    const svc = new OpenChargeMapService(serverConfig);
    const result = await svc.searchPois(
      { location: along(SEATTLE_PORTLAND_ROUTE, 3.1, 'Miles') },
      spiedCtx().ctx,
    );

    // 3.1 miles is 4.99 km; the request still goes out in km, widened past it.
    expect(sentQuery().get('distanceunit')).toBe('KM');
    expect(Number(sentQuery().get('distance'))).toBeGreaterThan(13.3);
    const olympia = result.matches.find((s) => s.id === 379255)!;
    expect(olympia.distanceUnit).toBe('Miles');
    expect(Math.abs(olympia.offRouteDistance! - 2.41 / 1.609344)).toBeLessThan(0.05);
    expect((result.area as { length: number }).length).toBeCloseTo(154.47, 2);
    // 4.62 km (2.87 mi) is inside 3.1 miles; 5.96 km (3.70 mi) is not.
    expect(result.matches.map((s) => s.id)).toContain(379328);
    expect(result.matches.map((s) => s.id)).not.toContain(233702);
  });

  it('breaks an along-route tie by the distance off the route, then by station id', async () => {
    // An equatorial leg 20° east of the 0,0 placeholder square: 0.5° along is 55.6 km, 0.1° off 11.12.
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        routePoi(9, 0.1, 20.5),
        routePoi(7, -0.05, 20.5),
        routePoi(4, -0.05, 20.5),
        routePoi(2, 0, 20.9),
      ]),
    );
    const svc = new OpenChargeMapService(serverConfig);
    const result = await svc.searchPois(
      {
        location: along(
          [
            { latitude: 0, longitude: 20 },
            { latitude: 0, longitude: 21 },
          ],
          20,
        ),
      },
      spiedCtx().ctx,
    );

    expect(result.matches.map((s) => [s.id, s.routeDistance, s.offRouteDistance])).toEqual([
      [4, 55.6, 5.56],
      [7, 55.6, 5.56],
      [9, 55.6, 11.12],
      [2, 100.08, 0],
    ]);
  });

  it.each([
    ['crosses ±180°', [170, 177, -177], '354°'],
    ['spans exactly 180°', [-95, -90, 90], '180°'],
  ])('refuses a leg that %s before any request', async (_label, longitudes, span) => {
    const svc = new OpenChargeMapService(serverConfig);
    const error = await rejection(() =>
      svc.searchPois(
        { location: along(longitudes.map((longitude) => ({ latitude: 64.5, longitude }))) },
        spiedCtx().ctx,
      ),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_location' },
    });
    expect(error.message).toContain(`route[1] and route[2] are ${span} of longitude apart`);
    expect(error.data?.recovery?.hint).toMatch(/two routes, one on each side/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('searches a leg just short of 180°', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const svc = new OpenChargeMapService(serverConfig);
    await svc.searchPois(
      {
        location: along([
          { latitude: 10, longitude: -89.99 },
          { latitude: 10, longitude: 90 },
        ]),
      },
      spiedCtx().ctx,
    );

    expect(fetchWithTimeout).toHaveBeenCalledOnce();
  });

  it('refuses a corridor past a pole and names the widest one that fits, which then runs', async () => {
    const svalbard = [
      { latitude: 78.22, longitude: 15.65 },
      { latitude: 78.92, longitude: 11.93 },
    ];
    const svc = new OpenChargeMapService(serverConfig);
    const error = await rejection(() =>
      svc.searchPois({ location: along(svalbard, 500) }, spiedCtx().ctx),
    );

    expect(error).toMatchObject({ data: { reason: 'invalid_location' } });
    expect(error.message).toContain('reaches past a pole or ±180° longitude');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    const widest = Number(
      /Narrow distance to ([\d.]+) KM or less/.exec(error.data?.recovery?.hint ?? '')?.[1],
    );
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThan(500);

    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await svc.searchPois({ location: along(svalbard, widest) }, spiedCtx().ctx);
    // The buffer it asked for stays south of the pole: 200 km of distance per degree of buffer.
    expect(Number(sentQuery().get('distance')) / 200).toBeLessThanOrEqual(90 - 78.92);
  });

  it('refuses any corridor around a point on ±180° and points to a center or a box', async () => {
    const svc = new OpenChargeMapService(serverConfig);
    const error = await rejection(() =>
      svc.searchPois(
        {
          location: along(
            [
              { latitude: -16.5, longitude: 179.5 },
              { latitude: -16.8, longitude: 180 },
            ],
            1,
          ),
        },
        spiedCtx().ctx,
      ),
    );

    expect(error.data?.recovery?.hint).toMatch(/too close .* for any corridor/);
    expect(error.data?.recovery?.hint).not.toMatch(/Narrow distance/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('sends a request of exactly 8,177 bytes and refuses one byte more', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await new OpenChargeMapService(serverConfig).searchPois(
      { location: along(SEATTLE_PORTLAND_ROUTE) },
      spiedCtx().ctx,
    );
    const base = new URL(String(fetchWithTimeout.mock.calls[0]![0]));
    const baseBytes = base.pathname.length + base.search.length;
    fetchWithTimeout.mockClear();

    /** A service whose base URL pads the request target to `bytes`. */
    const padded = (bytes: number) =>
      new OpenChargeMapService({
        ...serverConfig,
        baseUrl: `https://api.openchargemap.io/${'p'.repeat(bytes - baseBytes - 1)}/v3`,
      });
    await padded(8177).searchPois({ location: along(SEATTLE_PORTLAND_ROUTE) }, spiedCtx().ctx);
    const sent = new URL(String(fetchWithTimeout.mock.calls[0]![0]));
    expect(sent.pathname.length + sent.search.length).toBe(8177);

    fetchWithTimeout.mockClear();
    const error = await rejection(() =>
      padded(8178).searchPois({ location: along(SEATTLE_PORTLAND_ROUTE) }, spiedCtx().ctx),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_location' },
    });
    expect(error.message).toBe(
      'This route makes a 8178-byte request to Open Charge Map, past the 8177 bytes it accepts.',
    );
    expect(error.data?.recovery?.hint).toMatch(/fewer route points/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('refuses 500 widely spaced points whose polyline outgrows the request limit', async () => {
    // Every leg jumps 160° of latitude and 179° of longitude: 500 such points encode past 8 KB.
    const zigzag = Array.from({ length: 500 }, (_, i) => ({
      latitude: i % 2 ? -80 : 80,
      longitude: i % 2 ? 89.5 : -89.5,
    }));
    const svc = new OpenChargeMapService(serverConfig);
    const error = await rejection(() =>
      svc.searchPois({ location: along(zigzag) }, spiedCtx().ctx),
    );

    expect(error).toMatchObject({ data: { reason: 'invalid_location' } });
    expect(error.message).toMatch(/past the 8177 bytes it accepts/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('reports an upstream remainder and no reach for a route pool', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(
        Array.from({ length: 501 }, (_, i) => routePoi(10_000 - i, 47.6062, -122.3321 - i * 1e-4)),
      ),
    );
    const result = await new OpenChargeMapService(serverConfig).searchPois(
      { location: along(SEATTLE_PORTLAND_ROUTE) },
      spiedCtx().ctx,
    );

    expect(result).toMatchObject({ fetched: 500, moreUpstream: true });
    expect(result).not.toHaveProperty('reach');
    expect(result.matches).toHaveLength(500);
  });

  it('caches one pool per route and corridor', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(seattlePortlandPool()));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();
    await svc.searchPois({ location: along(SEATTLE_PORTLAND_ROUTE) }, ctx);
    await svc.searchPois({ location: along(SEATTLE_PORTLAND_ROUTE) }, ctx);
    expect(fetchWithTimeout).toHaveBeenCalledOnce();

    await svc.searchPois({ location: along(SEATTLE_PORTLAND_ROUTE, 6) }, ctx);
    await svc.searchPois({ location: along(SEATTLE_PORTLAND_ROUTE.slice(0, 3)) }, ctx);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  });
});
