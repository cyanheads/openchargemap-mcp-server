/**
 * @fileoverview Tests for openchargemap_find_stations — headline radius search, bounding-box mode,
 * the invalid-location and no-stations contract errors, sparse-payload tolerance, and the upstream
 * auth/unavailable error paths (the fetch mock THROWS on non-OK, mirroring the real framework).
 * @module tests/tools/find-stations.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawPoi } from '@/services/openchargemap/types.js';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    // Pass-through: exercise the handler/translate path once, without backoff delays.
    withRetry: (fn: () => unknown) => fn(),
  };
});

const { findStations } = await import('@/mcp-server/tools/definitions/find-stations.tool.js');
const { MAX_SEARCH_WINDOW } = await import('@/services/openchargemap/openchargemap-service.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const { FULL_POI, SPARSE_POI, ZERO_COORD_POI, jsonResponse } = await import('../fixtures/ocm.js');

const serverConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};

beforeEach(async () => {
  fetchWithTimeout.mockReset();
  await initReferenceDataService(serverConfig);
  initOpenChargeMapService(serverConfig);
});

afterEach(() => {
  vi.clearAllMocks();
});

const ctx = () => createMockContext({ tenantId: 'test', errors: findStations.errors });

/**
 * Run a handler call and return what it threw. `tool()` types `handler` as `T | Promise<T>`, so the
 * call is awaited rather than promise-chained — and a call that returns instead of throwing fails
 * here rather than silently satisfying the assertions below.
 */
async function thrownBy(run: () => unknown): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected the handler to throw, but it returned.');
}

describe('openchargemap_find_stations', () => {
  it('finds stations near a point and returns normalized fields (headline goal)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const input = findStations.input.parse({
      latitude: 47.6685,
      longitude: -122.387,
      distance: 15,
    });
    const result = await findStations.handler(input, ctx());

    expect(result.stations).toHaveLength(1);
    const s = result.stations[0]!;
    expect(s.id).toBe(145452);
    expect(s.title).toBe('AMLI Mark24');
    expect(s.distance).toBeCloseTo(0.1445);
    expect(s.distanceUnit).toBe('KM'); // normalized from integer enum 1
    expect(s.operator).toBe('ChargePoint');
    expect(s.status).toBe('Temporarily Unavailable');
    expect(s.isOperational).toBe(true);
    expect(s.connections[0]).toMatchObject({
      connectionType: 'Type 1 (J1772)',
      powerKW: 3.7,
      quantity: 2,
    });
    expect(result.attribution).toContain('CC BY 4.0');
    expect(result.searchSummary).toContain('Within 15 KM');
  });

  it('sends the request with the API key header and json/verbose=false params', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    await findStations.handler(findStations.input.parse({ latitude: 47, longitude: -122 }), ctx());

    const [url, , , options] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('verbose=false');
    expect(String(url)).toContain('output=json');
    expect((options as { headers: Record<string, string> }).headers['X-API-Key']).toBe('test-key');
  });

  it('supports bounding-box search and serializes the box', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const input = findStations.input.parse({
      boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2 },
    });
    await findStations.handler(input, ctx());
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(decodeURIComponent(String(url))).toContain('boundingbox=(47.5,-122.5),(47.7,-122.2)');
  });

  it('accepts pole and antimeridian coordinate boundaries', async () => {
    for (const [latitude, longitude] of [
      [90, 180],
      [-90, -180],
      [0, 180],
    ] as const) {
      fetchWithTimeout.mockResolvedValueOnce(jsonResponse([FULL_POI]));
      await expect(
        findStations.handler(findStations.input.parse({ latitude, longitude }), ctx()),
      ).resolves.toEqual(expect.schemaMatching(findStations.output));
    }
  });

  it('preserves an antimeridian-crossing bounding box at the API boundary', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    await findStations.handler(
      findStations.input.parse({
        boundingbox: { sw_lat: -10, sw_lng: 170, ne_lat: 10, ne_lng: -170 },
      }),
      ctx(),
    );

    const url = decodeURIComponent(String(fetchWithTimeout.mock.calls[0]![0]));
    expect(url).toContain('boundingbox=(-10,170),(10,-170)');
  });

  it('accepts the maximum 500-unit radius', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    await findStations.handler(
      findStations.input.parse({ latitude: 90, longitude: 180, distance: 500 }),
      ctx(),
    );

    expect(String(fetchWithTimeout.mock.calls[0]![0])).toContain('distance=500');
  });

  it.each([
    ['latitude below minimum', { latitude: -90.000_001, longitude: 0 }],
    ['latitude above maximum', { latitude: 90.000_001, longitude: 0 }],
    ['longitude below minimum', { latitude: 0, longitude: -180.000_001 }],
    ['longitude above maximum', { latitude: 0, longitude: 180.000_001 }],
    ['zero radius', { latitude: 0, longitude: 0, distance: 0 }],
    ['negative radius', { latitude: 0, longitude: 0, distance: -1 }],
    ['radius above maximum', { latitude: 0, longitude: 0, distance: 501 }],
    ['enormous radius', { latitude: 0, longitude: 0, distance: Number.MAX_SAFE_INTEGER }],
  ])('rejects %s at the Zod boundary', (_label, input) => {
    expect(() => findStations.input.parse(input)).toThrow();
  });

  it.each([
    ['connectiontypeid', 0],
    ['operatorid', -1],
    ['usagetypeid', 1.5],
    ['statustypeid', Array.from({ length: 11 }, (_, index) => index + 1)],
  ])('rejects invalid %s filters', (field, value) => {
    expect(() =>
      findStations.input.parse({ latitude: 47, longitude: -122, [field]: value }),
    ).toThrow();
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/14
  // Every ID filter is built by the same idFilter() factory, so all five are covered.
  it.each(['connectiontypeid', 'operatorid', 'usagetypeid', 'levelid', 'statustypeid'])(
    'rejects an empty %s array instead of silently disabling the filter',
    (field) => {
      expect(() =>
        findStations.input.parse({ latitude: 47, longitude: -122, [field]: [] }),
      ).toThrow();
    },
  );

  it.each(['connectiontypeid', 'operatorid', 'usagetypeid', 'levelid', 'statustypeid'])(
    'still accepts a single-element %s array and a bare scalar',
    (field) => {
      expect(
        findStations.input.safeParse({ latitude: 47, longitude: -122, [field]: [1] }).success,
      ).toBe(true);
      expect(
        findStations.input.safeParse({ latitude: 47, longitude: -122, [field]: 1 }).success,
      ).toBe(true);
    },
  );

  it('still treats an omitted ID filter as no filter at all', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    await findStations.handler(findStations.input.parse({ latitude: 47, longitude: -122 }), ctx());
    const url = String(fetchWithTimeout.mock.calls[0]![0]);
    for (const field of [
      'connectiontypeid',
      'operatorid',
      'usagetypeid',
      'levelid',
      'statustypeid',
    ])
      expect(url).not.toContain(field);
  });

  it('joins array filters as comma-separated OR lists', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, connectiontypeid: [32, 33] }),
      ctx(),
    );
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('connectiontypeid=32%2C33');
  });

  it('throws invalid_location when neither radius nor bbox is given', async () => {
    const input = findStations.input.parse({ maxresults: 10 });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_location' },
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('throws invalid_location when only one center coordinate is present', async () => {
    await expect(
      findStations.handler(findStations.input.parse({ latitude: 47 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_location' },
    });
    await expect(
      findStations.handler(findStations.input.parse({ longitude: -122 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_location' },
    });
  });

  it('throws invalid_location when BOTH radius and bbox are given', async () => {
    const input = findStations.input.parse({
      latitude: 47,
      longitude: -122,
      boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2 },
    });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'invalid_location' },
    });
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/17
  // A bounding box used to win over a half-supplied center, and the stray coordinate was dropped
  // with nothing in the response saying so.
  it.each([
    ['a stray latitude', { latitude: 47.6062 }, 'A latitude and a boundingbox were supplied'],
    ['a stray longitude', { longitude: -122.3321 }, 'A longitude and a boundingbox were supplied'],
  ])(
    'rejects a bounding box carrying %s instead of ignoring it',
    async (_label, coordinate, diagnosis) => {
      const error = await thrownBy(() =>
        findStations.handler(
          findStations.input.parse({
            ...coordinate,
            boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2 },
            maxresults: 2,
          }),
          ctx(),
        ),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_location' },
      });
      // The message names the coordinate that actually arrived...
      expect(error.message).toContain(diagnosis);
      // ...and never borrows the full-center wording for an input that carried no center.
      expect(error.message).not.toContain('Both a center');
      expect(error.message).toMatch(/not both/i);
      // Nothing was searched — a rejected call must not run the bounding-box search anyway.
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    },
  );

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/17
  // The two shapes the narrowed gate must still let through, unchanged.
  it.each([
    [
      'a bounding box on its own',
      { boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2 } },
    ],
    ['a complete center on its own', { latitude: 47.6062, longitude: -122.3321 }],
  ])('still searches for %s', async (_label, input) => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const result = await findStations.handler(findStations.input.parse(input), ctx());

    expect(result.stations).toHaveLength(1);
    expect(fetchWithTimeout).toHaveBeenCalledOnce();
  });

  it('throws no_stations on an empty result set', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const input = findStations.input.parse({ latitude: 47, longitude: -122, connectiontypeid: 33 });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_stations', recovery: { hint: expect.any(String) } },
    });
  });

  it('tolerates a sparse payload (absent StatusType, null power, no operator)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([SPARSE_POI]));
    const input = findStations.input.parse({ latitude: 51.5, longitude: -0.12 });
    const result = await findStations.handler(input, ctx());
    const s = result.stations[0]!;

    expect(s.status).toBeUndefined();
    expect(s.isOperational).toBeUndefined(); // StatusType key absent — never invented
    expect(s.operator).toBeUndefined();
    expect(s.numberOfPoints).toBeUndefined();
    expect(s.connections[0]!.powerKW).toBeNull();
    expect(result).toEqual(expect.schemaMatching(findStations.output));
  });

  // --- #1: minchargepoints applied locally (OCM's minnumberofpoints param is inert) ---

  it('post-filters minchargepoints locally, dropping stations below the count', async () => {
    const bigStation: RawPoi = { ...FULL_POI, ID: 999001, NumberOfPoints: 1000 };
    fetchWithTimeout.mockResolvedValue(jsonResponse([bigStation, FULL_POI, SPARSE_POI]));
    const input = findStations.input.parse({ latitude: 47, longitude: -122, minchargepoints: 10 });
    const result = await findStations.handler(input, ctx());
    const ids = result.stations.map((s) => s.id);
    expect(ids).toContain(999001); // numberOfPoints 1000 ≥ 10 → kept
    expect(ids).not.toContain(145452); // FULL_POI count 2 (summed connection quantity) < 10 → dropped
    expect(ids).toContain(253415); // SPARSE_POI has no count signal → unknown, not excluded
  });

  it('minchargepoints excludes a station via the connection-quantity fallback (numberOfPoints absent)', async () => {
    // FULL_POI: no NumberOfPoints, one connection Quantity 2 → count resolves to 2.
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const input = findStations.input.parse({ latitude: 47, longitude: -122, minchargepoints: 3 });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_stations' },
    });
  });

  it('minchargepoints keeps a station whose summed connection quantity meets the threshold', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const input = findStations.input.parse({ latitude: 47, longitude: -122, minchargepoints: 2 });
    const result = await findStations.handler(input, ctx());
    expect(result.stations.map((s) => s.id)).toContain(145452); // count 2 ≥ 2 → kept
  });

  it('minchargepoints never excludes a station with no count signal at all', async () => {
    // SPARSE_POI: no NumberOfPoints, connection Quantity null → count unknown → kept.
    fetchWithTimeout.mockResolvedValue(jsonResponse([SPARSE_POI]));
    const input = findStations.input.parse({
      latitude: 51.5,
      longitude: -0.12,
      minchargepoints: 5,
    });
    const result = await findStations.handler(input, ctx());
    expect(result.stations.map((s) => s.id)).toContain(253415);
  });

  // --- #2: zero-coordinate (0,0) and missing-coordinate records dropped from search ---

  it('drops zero-coordinate (0,0) records from radius search results', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI, ZERO_COORD_POI]));
    const input = findStations.input.parse({ latitude: 47, longitude: -122 });
    const result = await findStations.handler(input, ctx());
    const ids = result.stations.map((s) => s.id);
    expect(ids).toContain(145452); // real station kept
    expect(ids).not.toContain(494804); // 0,0 sentinel dropped
  });

  it('throws no_stations when every result is a 0,0 sentinel', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([ZERO_COORD_POI, { ...ZERO_COORD_POI, ID: 304716 }]),
    );
    const input = findStations.input.parse({
      latitude: 0,
      longitude: 0,
      distance: 1,
      countrycode: 'US',
    });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_stations' },
    });
  });

  it('drops records with missing coordinates (absent lat/lng) from search results', async () => {
    const noCoords: RawPoi = {
      ID: 777001,
      UUID: 'no-coords-0000-0000-0000-000000000000',
      AddressInfo: { ID: 9, Title: 'Ghost station', Country: { ISOCode: 'US' } },
      Connections: [],
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([noCoords]));
    const input = findStations.input.parse({ latitude: 47, longitude: -122 });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'no_stations' },
    });
  });

  it('keeps a station on the equator (single-axis zero is a real location)', async () => {
    const equatorStation: RawPoi = {
      ID: 888001,
      UUID: 'EQ000000-0000-0000-0000-000000000000',
      StatusType: { ID: 50, Title: 'Operational', IsOperational: true },
      AddressInfo: {
        ID: 8,
        Title: 'Kampala equator station',
        Country: { ISOCode: 'UG' },
        Latitude: 0,
        Longitude: 32.58,
        Distance: 5,
        DistanceUnit: 1,
      },
      Connections: [{ ID: 1, ConnectionTypeID: 25, Quantity: 2 }],
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([equatorStation]));
    const input = findStations.input.parse({ latitude: 0.1, longitude: 32.5 });
    const result = await findStations.handler(input, ctx());
    expect(result.stations.map((s) => s.id)).toContain(888001);
  });

  it('maps a 403 to auth_failed (fetch mock throws, as the real framework does on non-OK)', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Forbidden, 'HTTP 403'));
    const input = findStations.input.parse({ latitude: 47, longitude: -122 });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'auth_failed' },
    });
  });

  it('maps a 401 to the complete auth_failed error envelope', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Unauthorized, 'HTTP 401'));
    await expect(
      findStations.handler(findStations.input.parse({ latitude: 47, longitude: -122 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: {
        reason: 'auth_failed',
        retryable: false,
        recovery: { hint: expect.any(String) },
      },
    });
  });

  it('maps a 5xx to upstream_unavailable (fetch mock throws)', async () => {
    fetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'HTTP 503'),
    );
    const input = findStations.input.parse({ latitude: 47, longitude: -122 });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
  });

  it('format() renders every station with status and attribution', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47.6685, longitude: -122.387 }),
      ctx(),
    );
    const text = (findStations.format!(result)[0] as { text: string }).text;
    expect(text).toContain('AMLI Mark24');
    expect(text).toContain('Temporarily Unavailable');
    expect(text).toContain('CC BY 4.0');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/4
  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('carries explicit false flags and the availability wording into search results too', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47.6685, longitude: -122.387 }),
      ctx(),
    );
    const text = (findStations.format!(result)[0] as { text: string }).text;

    expect(result.stations[0]).toMatchObject({
      isPayAtLocation: false,
      isRecentlyVerified: false,
      statusTypeId: 30,
      isOperational: true,
    });
    expect(text).toContain('pay at location: no');
    expect(text).toContain('recently verified: no');
    expect(text).not.toContain('Temporarily Unavailable (operational)');
    expect(text).toContain('not usable right now');
  });

  it('returns output conforming to the declared schema and cap enrichment', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI, { ...FULL_POI, ID: 145453 }]));
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 1 }),
      c,
    );

    expect(result).toEqual(expect.schemaMatching(findStations.output));
    expect(getEnrichment(c)).toMatchObject({
      totalCount: 2,
      truncated: true,
      shown: 1,
      cap: 1,
      nextOffset: 1,
    });
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  // truncated used to fire whenever the post-filter count reached maxresults, so a page that
  // happened to be exactly as long as the cap reported more data that did not exist.
  it('does not report truncation when the whole match set fits the page', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const c = ctx();
    await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 1 }),
      c,
    );

    const enrichment = getEnrichment(c);
    expect(enrichment).toMatchObject({ totalCount: 1 });
    expect(enrichment).not.toHaveProperty('truncated');
    expect(enrichment).not.toHaveProperty('nextOffset');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/12
  it('names whether both location modes or neither were supplied', async () => {
    const neither = await thrownBy(() => findStations.handler(findStations.input.parse({}), ctx()));
    const both = await thrownBy(() =>
      findStations.handler(
        findStations.input.parse({
          latitude: 47,
          longitude: -122,
          boundingbox: { sw_lat: 46, sw_lng: -123, ne_lat: 48, ne_lng: -121 },
        }),
        ctx(),
      ),
    );

    expect(neither.message).toMatch(/provide/i);
    expect(both.message).toMatch(/not both/i);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/12
  // A half-supplied center used to report that no location was given at all.
  it.each([
    ['latitude only', { latitude: 47 }, /longitude is missing/i, /latitude is missing/i],
    ['longitude only', { longitude: -122 }, /latitude is missing/i, /longitude is missing/i],
  ])(
    'names the missing coordinate when only %s is supplied',
    async (_label, input, named, absent) => {
      const error = await thrownBy(() =>
        findStations.handler(findStations.input.parse(input), ctx()),
      );

      expect(error).toMatchObject({ data: { reason: 'invalid_location' } });
      expect(error.message).toMatch(named);
      expect(error.message).not.toMatch(absent);
      // The old generic text claimed nothing was provided, which was wrong here.
      expect(error.message).not.toMatch(/neither/i);
    },
  );

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/12
  // The sibling tools carry the same contract entry; the smoke suite asserts all three together.
  it('documents both HTTP 401 and 403 in the auth_failed contract', () => {
    const auth = findStations.errors?.find((entry) => entry.reason === 'auth_failed');
    expect(auth?.when).toContain('401');
    expect(auth?.when).toContain('403');
  });

  // --- #8: cap accounting runs on the raw upstream page, not the post-filter result ---

  /** A candidate page OCM filled to the requested cap — the shape that hides matches past it. */
  function fullCandidatePage(poi: RawPoi): void {
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      return Promise.resolve(
        jsonResponse(Array.from({ length: cap }, (_, index) => ({ ...poi, ID: 900_000 + index }))),
      );
    });
  }

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('does not report no_stations when a capped page is emptied by local filters', async () => {
    fullCandidatePage(FULL_POI); // every record's charge-point count is 2, below the filter
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({
        latitude: 47,
        longitude: -122,
        minchargepoints: 10,
        maxresults: 1,
      }),
      c,
    );

    expect(result.stations).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({ truncated: true, shown: 0, totalCount: 0 });
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('reports a capped page as truncated even when local filtering shrank it below the cap', async () => {
    // A full candidate page of below-threshold records, with one match seeded at the front.
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      const page: RawPoi[] = [{ ...FULL_POI, ID: 1, NumberOfPoints: 20 }];
      for (let index = 1; index < cap; index += 1) page.push({ ...FULL_POI, ID: 1000 + index });
      return Promise.resolve(jsonResponse(page));
    });
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({
        latitude: 47,
        longitude: -122,
        minchargepoints: 10,
        maxresults: 25,
      }),
      c,
    );

    // One survivor out of a cap-25 request would previously have read as "not truncated".
    expect(result.stations.map((s) => s.id)).toEqual([1]);
    const enrichment = getEnrichment(c) as { truncated?: boolean; nextOffset?: number };
    expect(enrichment.truncated).toBe(true);
    // Nothing further was retrieved, so there is no next page to point at — the notice says so.
    expect(enrichment.nextOffset).toBeUndefined();
    expect(getEnrichment(c).notice).toMatch(/narrow the area or add filters/i);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('finds a match ranked past the requested maxresults instead of throwing no_stations', async () => {
    // Requesting one station returns one below-threshold record; the wider candidate page has the match.
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      const belowMinimum = { ...FULL_POI, ID: 1, NumberOfPoints: 1 };
      const matching = { ...FULL_POI, ID: 2, NumberOfPoints: 8 };
      return Promise.resolve(jsonResponse(cap === 1 ? [belowMinimum] : [belowMinimum, matching]));
    });
    const result = await findStations.handler(
      findStations.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        minchargepoints: 6,
        maxresults: 1,
      }),
      ctx(),
    );

    expect(result.stations.map((s) => s.id)).toEqual([2]);
  });

  // --- #1 / #2 still hold once filtering runs over the wider candidate page ---

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/1
  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  // Over-fetching gives minchargepoints a bigger pool to cull; culling it must stay just as strict,
  // including on records ranked past the caller's window.
  it('applies minchargepoints across the whole candidate page, not just the caller window', async () => {
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      const page = Array.from({ length: cap }, (_, index) =>
        // Every fourth record clears the threshold; the rest sit at FULL_POI's count of 2.
        index % 4 === 0
          ? { ...FULL_POI, ID: 1000 + index, NumberOfPoints: 20 }
          : { ...FULL_POI, ID: 1000 + index },
      );
      return Promise.resolve(jsonResponse(page));
    });
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({
        latitude: 47,
        longitude: -122,
        minchargepoints: 10,
        maxresults: 200,
      }),
      c,
    );

    expect(result.stations.length).toBeGreaterThan(1);
    expect(result.stations.every((s) => s.numberOfPoints === 20)).toBe(true);
    // The whole candidate page was filtered — one in four of 500 candidates survived.
    expect(getEnrichment(c).totalCount).toBe(125);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/2
  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('drops 0,0 sentinel records everywhere in the candidate page, including past the window', async () => {
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      const page = Array.from({ length: cap }, (_, index) =>
        index % 2 === 0
          ? { ...ZERO_COORD_POI, ID: 500_000 + index }
          : { ...FULL_POI, ID: 500_000 + index },
      );
      return Promise.resolve(jsonResponse(page));
    });
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 200 }),
      c,
    );

    expect(result.stations).not.toHaveLength(0);
    expect(
      result.stations.every((s) => !(s.address.latitude === 0 && s.address.longitude === 0)),
    ).toBe(true);
    // Half of the 500 candidates were sentinels — the filter ran over all of them, not the first 200.
    expect(getEnrichment(c).totalCount).toBe(250);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/1
  it('still keeps a no-count-signal station when minchargepoints filters a full candidate page', async () => {
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      const page: RawPoi[] = Array.from({ length: cap - 1 }, (_, index) => ({
        ...FULL_POI,
        ID: 2000 + index,
      }));
      page.push(SPARSE_POI); // no numberOfPoints, null connection quantity → unknown, not below
      return Promise.resolve(jsonResponse(page));
    });
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, minchargepoints: 10 }),
      ctx(),
    );

    expect(result.stations.map((s) => s.id)).toEqual([253415]);
  });

  // --- #5: offset paging over the retrieved match set ---

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('pages the retrieved matches by offset and names the next one', async () => {
    const page = [1, 2, 3, 4, 5].map((id) => ({ ...FULL_POI, ID: id }));
    fetchWithTimeout.mockResolvedValue(jsonResponse(page));

    const first = ctx();
    const firstPage = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 2 }),
      first,
    );
    expect(firstPage.stations.map((s) => s.id)).toEqual([1, 2]);
    expect(getEnrichment(first)).toMatchObject({ totalCount: 5, shown: 2, nextOffset: 2 });

    const second = ctx();
    const secondPage = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 2, offset: 2 }),
      second,
    );
    expect(secondPage.stations.map((s) => s.id)).toEqual([3, 4]);
    expect(getEnrichment(second)).toMatchObject({ totalCount: 5, nextOffset: 4 });

    const last = ctx();
    const lastPage = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 2, offset: 4 }),
      last,
    );
    expect(lastPage.stations.map((s) => s.id)).toEqual([5]);
    expect(getEnrichment(last)).not.toHaveProperty('nextOffset');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('echoes the offset in the search summary and reaches content[] through the notice', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([1, 2, 3].map((id) => ({ ...FULL_POI, ID: id }))),
    );
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 1, offset: 1 }),
      c,
    );

    expect(result.searchSummary).toContain('offset=1');
    // enrich.truncated() routes its guidance through `notice`, and the effective-output parse
    // strips any enrichment key the block does not declare — so the declaration is what keeps the
    // continuation advice on the wire, not the write.
    expect(getEnrichment(c).notice).toContain('offset 2');
    expect(findStations.enrichment).toHaveProperty('notice');
    expect(findStations.enrichment).toHaveProperty('nextOffset');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('says the offset is past the last station the search retrieved', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, offset: 5, maxresults: 25 }),
      c,
    );

    expect(result.stations).toEqual([]);
    expect(getEnrichment(c).notice).toMatch(/past the end/i);
    expect(getEnrichment(c)).not.toHaveProperty('nextOffset');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('says the offset is past the end of a full candidate page that filtering shrank', async () => {
    // A full candidate page holding one qualifying record — the survivors end well before the
    // requested offset, so the empty page is the offset overshooting, not an empty search area.
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      const page: RawPoi[] = [{ ...FULL_POI, ID: 1, NumberOfPoints: 20 }];
      for (let index = 1; index < cap; index += 1) page.push({ ...FULL_POI, ID: 1000 + index });
      return Promise.resolve(jsonResponse(page));
    });
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({
        latitude: 47,
        longitude: -122,
        minchargepoints: 10,
        offset: 5,
        maxresults: 25,
      }),
      c,
    );

    expect(result.stations).toEqual([]);
    expect(getEnrichment(c).notice).toMatch(/past the last one/i);
    expect(getEnrichment(c).notice).toMatch(/narrow the area or add filters/i);
    expect(getEnrichment(c)).not.toHaveProperty('nextOffset');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('rejects an offset past the deepest station one search can reach', () => {
    expect(() =>
      findStations.input.parse({ latitude: 47, longitude: -122, offset: MAX_SEARCH_WINDOW }),
    ).toThrow();
    // One below is the deepest slot a page can actually occupy, so it must still parse.
    expect(() =>
      findStations.input.parse({ latitude: 47, longitude: -122, offset: MAX_SEARCH_WINDOW - 1 }),
    ).not.toThrow();
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('shares one upstream fetch across windows on the same candidate page, and refetches past it', async () => {
    fetchWithTimeout.mockImplementation((url: string) => {
      const cap = Number(new URL(String(url)).searchParams.get('maxresults'));
      return Promise.resolve(
        jsonResponse(Array.from({ length: cap }, (_, index) => ({ ...FULL_POI, ID: index + 1 }))),
      );
    });
    const c = ctx();
    const page = (offset: number) =>
      findStations.handler(
        findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 10, offset }),
        c,
      );

    await page(0);
    await page(10);
    // Both windows quantize to the same candidate page, so the second is served from cache.
    expect(fetchWithTimeout).toHaveBeenCalledOnce();

    // A window that outgrows that page fetches the next size up — paging is NOT one fetch per
    // search, and the rungs are close enough that a default-sized page crosses one every time.
    // `totalCount` climbs with the wider page, which is why no notice may state it as the number
    // of matching stations.
    await page(20);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(getEnrichment(c).totalCount).toBeGreaterThan(100);
  });

  // --- honesty of the truncation notice: what it may claim depends on the candidate page ---

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('does not claim more stations exist when the candidate page came back short', async () => {
    // Eight records against a 100-record candidate cap: the search retrieved everything Open
    // Charge Map holds for the area, so "narrow the area" would be false and paging is the fix.
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(Array.from({ length: 8 }, (_, index) => ({ ...FULL_POI, ID: index + 1 }))),
    );
    const c = ctx();
    await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 3 }),
      c,
    );

    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('8 matching stations');
    expect(notice).not.toMatch(/narrow the area/i);
    expect(notice).not.toMatch(/floor/i);
    expect(notice).toContain('Pass offset 3');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('calls the count a floor rather than a match total when the candidate page came back full', async () => {
    fullCandidatePage({ ...FULL_POI, NumberOfPoints: 20 });
    const c = ctx();
    await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 3 }),
      c,
    );

    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('100 stations retrieved');
    expect(notice).not.toContain('100 matching stations');
    expect(notice).toMatch(/floor/i);
  });
});
