/**
 * @fileoverview Tests for OpenChargeMapService at the service boundary — focused on the cache-key
 * contract. The framework's StorageService rejects any key outside `/^[a-zA-Z0-9_.\-/]+$/` (colons,
 * `?`, `=`, `&` are invalid). `createMockContext` now runs that same validator, so a malformed key
 * throws in a handler test too — but as a generic storage rejection from wherever it happened to be
 * written. These tests capture the exact keys the service passes to `ctx.state` and assert them
 * against the pattern directly, so a regression names the offending key instead of a caller.
 * @module tests/services/openchargemap-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    withRetry: (fn: () => unknown) => fn(),
  };
});

const { OpenChargeMapService } = await import('@/services/openchargemap/openchargemap-service.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { BLANK_COMMENTS_POI, FULL_POI, FULL_POI_DETAIL, SPARSE_POI, ZERO_COORD_POI, jsonResponse } =
  await import('../fixtures/ocm.js');

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

describe('OpenChargeMapService cache keys are storage-safe', () => {
  it('searchPois uses a key the framework storage validator accepts (no colons)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx, getSpy, setSpy } = spiedCtx();

    await svc.searchPois({ window: 10, latitude: 47.6, longitude: -122.3, distance: 5 }, ctx);

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
    await svc.searchPois({ window: 10, latitude: 47.6, longitude: -122.3, distance: 5 }, c1);
    const { ctx: c2, setSpy: s2 } = spiedCtx();
    await svc.searchPois({ window: 10, latitude: 51.5, longitude: -0.12, distance: 5 }, c2);

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
  it('serializes every supported search filter at the OCM boundary', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();

    await svc.searchPois(
      {
        window: 17,
        latitude: 47.6,
        longitude: -122.3,
        distance: 500,
        distanceUnit: 'Miles',
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
      distance: '500',
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
    expect(url.searchParams.get('maxresults')).toBe('100');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('sizes the upstream page above the caller window so local filters have candidates to spare', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);

    for (const [window, expectedCap] of [
      [1, '100'],
      [25, '100'],
      [50, '250'],
      [200, '500'],
      [500, '500'],
    ] as const) {
      fetchWithTimeout.mockClear();
      await svc.searchPois({ window, latitude: 47.6, longitude: -122.3 }, spiedCtx().ctx);
      const url = new URL(String(fetchWithTimeout.mock.calls[0]![0]));
      expect(url.searchParams.get('maxresults')).toBe(expectedCap);
    }
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('serves every window over one search from a single upstream fetch', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI, SPARSE_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();

    // Same search, three windows inside the same candidate page (1 × 4, 10 × 4, 25 × 4 ≤ 100).
    for (const window of [1, 10, 25]) {
      await svc.searchPois({ window, latitude: 47.6, longitude: -122.3 }, ctx);
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
      { window: 10, latitude: 47.6, longitude: -122.3, minchargepoints: 999 },
      spiedCtx().ctx,
    );

    expect(result).toMatchObject({ candidateCap: 100, fetched: 2 });
    expect(result.matches).toEqual([]);
  });

  it('normalizes full and sparse station records without fabricating optional facts', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI, SPARSE_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { matches } = await svc.searchPois(
      { window: 10, latitude: 47.6, longitude: -122.3 },
      spiedCtx().ctx,
    );

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
    const params = { window: 10, latitude: 47.6, longitude: -122.3 };

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
    const nested = await svc.searchPois(
      { window: 1, latitude: 47.6, longitude: -122.3 },
      spiedCtx().ctx,
    );
    expect(nested.matches[0]?.statusTypeId).toBe(30);
    expect(nested.matches[0]?.isOperational).toBe(true); // upstream flag untouched

    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([{ ...FULL_POI, StatusType: null, StatusTypeID: 100 }]),
    );
    const bare = await svc.searchPois({ window: 1, latitude: 1, longitude: 1 }, spiedCtx().ctx);
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
      svc.searchPois({ window: 10, latitude: 47.6, longitude: -122.3 }, spiedCtx().ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
  });

  it('preserves an empty array as a valid empty upstream result', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const svc = new OpenChargeMapService(serverConfig);

    await expect(
      svc.searchPois({ window: 10, latitude: 47.6, longitude: -122.3 }, spiedCtx().ctx),
    ).resolves.toMatchObject({ fetched: 0, matches: [] });
  });

  it('maps both HTTP 401 and 403 boundary failures to auth_failed', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const svc = new OpenChargeMapService(serverConfig);

    for (const code of [JsonRpcErrorCode.Unauthorized, JsonRpcErrorCode.Forbidden]) {
      fetchWithTimeout.mockRejectedValueOnce(new McpError(code, `HTTP ${code}`));
      await expect(
        svc.searchPois({ window: 10, latitude: 47.6, longitude: -122.3 }, spiedCtx().ctx),
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
      { window: 1, latitude: 47.6, longitude: -122.3, minchargepoints: 6 },
      spiedCtx().ctx,
    );
    expect(result.matches.map((station) => station.id)).toEqual([2]);
  });
});
