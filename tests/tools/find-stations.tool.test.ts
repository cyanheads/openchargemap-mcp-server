/**
 * @fileoverview Tests for openchargemap_find_stations — headline radius search, bounding-box mode,
 * the invalid-location and no-stations contract errors, sparse-payload tolerance, and the upstream
 * auth/unavailable error paths (the fetch mock THROWS on non-OK, mirroring the real framework).
 * @module tests/tools/find-stations.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawPoi } from '@/services/openchargemap/types.js';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    // Pass-through: exercise the handler/translate path once, without backoff delays.
    withRetry: ((fn, options) =>
      fn({
        signal: options?.signal ?? new AbortController().signal,
        remainingMs: Number.POSITIVE_INFINITY,
      })) satisfies typeof actual.withRetry,
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
const {
  FULL_POI,
  LONDON_POI,
  SEATTLE_PORTLAND_ROUTE,
  SEATTLE_PORTLAND_ROWS,
  SPARSE_POI,
  ZERO_COORD_POI,
  contentText,
  jsonResponse,
  routePoi,
} = await import('../fixtures/ocm.js');

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
 * The recovery hint `errors[]` declares for a reason. A throw carries only the reason; the handler
 * boundary (production, and `runToolContract`) fills this hint in from the contract.
 */
function declaredRecovery(reason: string): string {
  const hint = findStations.errors?.find((entry) => entry.reason === reason)?.recovery;
  if (!hint) throw new Error(`findStations declares no recovery for ${reason}`);
  return hint;
}

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
    expect(result.attribution).toContain('License terms vary by provider');
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

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/34
  it('supports bounding-box search as a distance search from the box center', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const input = findStations.input.parse({
      boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2 },
    });
    const result = await findStations.handler(input, ctx());
    const sent = new URL(String(fetchWithTimeout.mock.calls[0]![0])).searchParams;
    expect(sent.has('boundingbox')).toBe(false);
    expect(Number(sent.get('latitude'))).toBeCloseTo(47.6, 9);
    expect(Number(sent.get('longitude'))).toBeCloseTo(-122.35, 9);
    expect(result.stations.map((s) => s.id)).toEqual([145452]);
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

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/34
  it('searches an antimeridian-crossing bounding box from its midpoint across ±180°', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    await findStations.handler(
      findStations.input.parse({
        boundingbox: { sw_lat: -10, sw_lng: 170, ne_lat: 10, ne_lng: -170 },
      }),
      ctx(),
    );

    const sent = new URL(String(fetchWithTimeout.mock.calls[0]![0])).searchParams;
    expect(sent.has('boundingbox')).toBe(false);
    // The 20°-wide box east of 170°E and west of 170°W, not the 340° span between them.
    expect(Number(sent.get('latitude'))).toBe(0);
    expect(Math.abs(Number(sent.get('longitude')))).toBe(180);
    expect(sent.get('distance')).toBe('1570.27');
  });

  it('accepts the maximum 500-unit radius', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    await findStations.handler(
      findStations.input.parse({ latitude: 90, longitude: 180, distance: 500 }),
      ctx(),
    );

    /**
     * Open Charge Map reports distances on a 6,371 km sphere and draws its search circle on a
     * 6,378.1 km one, so 500 km goes out as 500 × 6378.1 / 6371 = 500.5572 km, rounded up to three
     * decimals (500.558) plus 0.001.
     */
    expect(sentSearch().get('distance')).toBe('500.559');
    expect(sentSearch().get('distanceunit')).toBe('KM');
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
    ['connectiontypeid', -1],
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

  it('returns empty success with recovery on both surfaces', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const result = await runToolContract(
      findStations,
      { latitude: 47, longitude: -122, connectiontypeid: 33 },
      { context: { tenantId: 'test' } },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      stations: [],
      totalCount: 0,
      notice: expect.stringContaining('Widen'),
    });
    expect(JSON.stringify(result.content)).toContain('connectiontypeid=33');
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
    await expect(findStations.handler(input, ctx())).resolves.toMatchObject({ stations: [] });
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

  it('returns empty success when every result is a 0,0 coordinate placeholder', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([ZERO_COORD_POI, { ...ZERO_COORD_POI, ID: 304716 }]),
    );
    const input = findStations.input.parse({
      latitude: 0,
      longitude: 0,
      distance: 1,
      countrycode: 'US',
    });
    await expect(findStations.handler(input, ctx())).resolves.toMatchObject({ stations: [] });
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
    await expect(findStations.handler(input, ctx())).resolves.toMatchObject({ stations: [] });
  });

  it('carries the same distance on both surfaces, rounded to hundredths', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI])); // OCM Distance 0.1445
    const input = findStations.input.parse({ latitude: 47.6685, longitude: -122.387 });
    const result = await findStations.handler(input, ctx());
    const text = (findStations.format!(result)[0] as { text: string }).text;
    expect(result.stations[0]!.distance).toBe(0.14);
    expect(text).toContain('— 0.14 KM');
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

  it('drops placeholder records a hair off 0,0 (open ocean, no station can stand there)', async () => {
    const nearNullIsland = (ID: number, Latitude: number, Longitude: number): RawPoi => ({
      ...ZERO_COORD_POI,
      ID,
      AddressInfo: { ...ZERO_COORD_POI.AddressInfo, Latitude, Longitude, Distance: 0.01 },
    });
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        nearNullIsland(313297, -0.0000587, -0.0000225),
        nearNullIsland(313298, 0.02, -0.015),
        FULL_POI,
      ]),
    );
    const input = findStations.input.parse({ latitude: 0, longitude: 0, distance: 500 });
    const result = await findStations.handler(input, ctx());
    expect(result.stations.map((s) => s.id)).toEqual([145452]);
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
    const result = await runToolContract(
      findStations,
      { latitude: 47, longitude: -122 },
      { context: { tenantId: 'test' } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Unauthorized,
        data: {
          reason: 'auth_failed',
          retryable: false,
          recovery: { hint: declaredRecovery('auth_failed') },
        },
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
    expect(text).toContain('License terms vary by provider');
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
    expect(getEnrichment(c).notice).toMatch(/narrow the radius or add filters/i);
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
      const page: RawPoi[] = Array.from({ length: cap - 2 }, (_, index) => ({
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
    expect(getEnrichment(c).notice).toMatch(/narrow the radius or add filters/i);
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
  it('shares one upstream fetch across every window of the fixed candidate pool', async () => {
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
    // Both windows use the same fixed candidate pool.
    expect(fetchWithTimeout).toHaveBeenCalledOnce();

    await page(20);
    await page(490);
    expect(fetchWithTimeout).toHaveBeenCalledOnce();
    expect(getEnrichment(c).totalCount).toBe(500);
  });

  // --- honesty of the truncation notice: what it may claim depends on the candidate page ---

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it('does not claim more stations exist when the candidate page came back short', async () => {
    // Eight records against a 100-record candidate cap: the search retrieved everything Open
    // Charge Map holds for the area, so "narrow the radius" would be false and paging is the fix.
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
    expect(notice).not.toMatch(/narrow the radius/i);
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
    expect(notice).toContain('500 stations retrieved');
    expect(notice).not.toContain('500 matching stations');
    expect(notice).toMatch(/floor/i);
  });
});

/** A search row at a point, carrying the distance Open Charge Map reports for it. */
function stationRow(id: number, latitude: number, longitude: number, distance: number): RawPoi {
  return {
    ...FULL_POI,
    ID: id,
    AddressInfo: {
      ...FULL_POI.AddressInfo,
      Latitude: latitude,
      Longitude: longitude,
      Distance: distance,
    },
  };
}

/** The query string of the n-th upstream request. */
function sentSearch(call = 0): URLSearchParams {
  return new URL(String(fetchWithTimeout.mock.calls[call]![0])).searchParams;
}

const SEATTLE_BOX = { sw_lat: 47.4, sw_lng: -122.5, ne_lat: 47.8, ne_lng: -122.1 };
const KAMCHATKA_ALASKA_BOX = { sw_lat: 52.5, sw_lng: 158, ne_lat: 61.5, ne_lng: -150.5 };

// https://github.com/cyanheads/openchargemap-mcp-server/issues/34
describe('openchargemap_find_stations bounding box as a distance search from its center', () => {
  it('sends the box center and a distance reaching its farthest point, never a boundingbox', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await findStations.handler(findStations.input.parse({ boundingbox: SEATTLE_BOX }), ctx());

    const sent = sentSearch();
    expect(sent.has('boundingbox')).toBe(false);
    expect(Number(sent.get('latitude'))).toBeCloseTo(47.6, 9);
    expect(Number(sent.get('longitude'))).toBeCloseTo(-122.3, 9);
    // The farthest corner is 26.84 km away on the 6,371 km sphere Open Charge Map reports distances
    // on; its search circle is drawn on a 6,378.1 km sphere, so the radius sent is scaled to match.
    expect(sent.get('distance')).toBe('26.87');
    expect(sent.get('distanceunit')).toBe('KM');
  });

  it('sizes the search in the requested distance unit', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await findStations.handler(
      findStations.input.parse({ boundingbox: SEATTLE_BOX, distanceUnit: 'Miles' }),
      ctx(),
    );

    expect(sentSearch().get('distance')).toBe('16.697');
    expect(sentSearch().get('distanceunit')).toBe('Miles');
  });

  it('reaches the middle of the east and west edges of a box wider than 180°', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    // 340° wide at the equator: the edge midpoints sit 170° from the center, the corners 165.9°.
    await findStations.handler(
      findStations.input.parse({
        boundingbox: { sw_lat: -10, sw_lng: -170, ne_lat: 10, ne_lng: 170 },
      }),
      ctx(),
    );

    expect(sentSearch().get('distance')).toBe('18924.205');
  });

  it('searches a whole-world box from its center out to the antipode and keeps every row', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        stationRow(2, -33.87, 151.2, 15_000),
        stationRow(1, 64.13, -21.9, 7000),
        stationRow(3, 47.6, -122.3, 13_000),
      ]),
    );
    const result = await findStations.handler(
      findStations.input.parse({
        boundingbox: { sw_lat: -90, sw_lng: -180, ne_lat: 90, ne_lng: 180 },
      }),
      ctx(),
    );

    expect(Number(sentSearch().get('latitude'))).toBe(0);
    expect(Number(sentSearch().get('longitude'))).toBe(0);
    expect(sentSearch().get('distance')).toBe('20037.394');
    expect(result.stations.map((s) => s.id)).toEqual([1, 3, 2]);
  });

  it('keeps stations on both sides of ±180° in a crossing box and drops rows outside it', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        stationRow(1, 53.02, 158.65, 1200), // Kamchatka, east of 180°
        stationRow(2, 60.55, -151.25, 1500), // Kenai Peninsula, west of 180°
        stationRow(3, 50, 179, 800), // inside the search circle, south of the box
        stationRow(4, 39.46, -123.81, 1700), // Fort Bragg, California
      ]),
    );
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({ boundingbox: KAMCHATKA_ALASKA_BOX }),
      c,
    );

    expect(Number(sentSearch().get('latitude'))).toBe(57);
    expect(Number(sentSearch().get('longitude'))).toBe(-176.25);
    expect(sentSearch().get('distance')).toBe('1716.762');
    expect(result.stations.map((s) => s.id)).toEqual([1, 2]);
    expect(getEnrichment(c).totalCount).toBe(2);
  });

  it('reads a box whose sw_lng exceeds its ne_lng as crossing ±180°, not the opposite span', async () => {
    // The Fiji box: the 355.5° complement of it reaches California, which the old pass-through returned.
    fetchWithTimeout.mockResolvedValue(jsonResponse([stationRow(84178, 39.46, -123.81, 9000)]));
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({
        boundingbox: { sw_lat: -19.5, sw_lng: 176.5, ne_lat: -15.5, ne_lng: -179 },
        maxresults: 2,
      }),
      c,
    );

    expect(Number(sentSearch().get('longitude'))).toBe(178.75);
    expect(sentSearch().get('distance')).toBe('327.466');
    expect(result.stations).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 0 });
    expect(getEnrichment(c).notice).toContain('No charging stations matched');
  });

  it('keeps rows outside the box out of the page, the count, and the continuation', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        stationRow(11, 47.6, -122.3, 1),
        stationRow(21, 47.9, -122.3, 1.5), // north of the box
        stationRow(12, 47.5, -122.2, 2),
        stationRow(22, 47.6, -122.6, 2.5), // west of the box
        stationRow(13, 47.79, -122.11, 3),
      ]),
    );
    const first = ctx();
    const firstPage = await findStations.handler(
      findStations.input.parse({ boundingbox: SEATTLE_BOX, maxresults: 2 }),
      first,
    );
    const second = ctx();
    const secondPage = await findStations.handler(
      findStations.input.parse({ boundingbox: SEATTLE_BOX, maxresults: 2, offset: 2 }),
      second,
    );

    expect(firstPage.stations.map((s) => s.id)).toEqual([11, 12]);
    expect(getEnrichment(first)).toMatchObject({
      totalCount: 3,
      truncated: true,
      shown: 2,
      nextOffset: 2,
    });
    expect(secondPage.stations.map((s) => s.id)).toEqual([13]);
    expect(getEnrichment(second)).toMatchObject({ totalCount: 3 });
    expect(getEnrichment(second)).not.toHaveProperty('nextOffset');
    expect(getEnrichment(second)).not.toHaveProperty('truncated');
  });

  it('sends the same upstream request for swapped latitude corners', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await findStations.handler(findStations.input.parse({ boundingbox: SEATTLE_BOX }), ctx());
    await findStations.handler(
      findStations.input.parse({ boundingbox: { ...SEATTLE_BOX, sw_lat: 47.8, ne_lat: 47.4 } }),
      ctx(),
    );

    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(sentSearch(1).toString()).toBe(sentSearch(0).toString());
  });

  it('names an antimeridian crossing and the box center in the search summary', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const crossing = await findStations.handler(
      findStations.input.parse({ boundingbox: KAMCHATKA_ALASKA_BOX }),
      ctx(),
    );
    const plain = await findStations.handler(
      findStations.input.parse({ boundingbox: SEATTLE_BOX }),
      ctx(),
    );

    expect(crossing.searchSummary).toContain('crossing the antimeridian');
    expect(crossing.searchSummary).toContain('from its center 57,-176.25');
    expect(plain.searchSummary).not.toContain('antimeridian');
    expect(plain.searchSummary).toContain('from its center 47.6,-122.3');
  });
});

// https://github.com/cyanheads/openchargemap-mcp-server/issues/35
describe('openchargemap_find_stations pool order and reach', () => {
  /** `count` stations at the Seattle box center, the n-th of them n/100 km out. */
  const ladder = (count: number, latitude = 47.6) =>
    Array.from({ length: count }, (_, index) =>
      stationRow(index + 1, latitude, -122.3, (index + 1) / 100),
    );

  it('orders the pool nearest first, with station id breaking distance ties', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        stationRow(9, 47.61, -122.3, 2),
        stationRow(4, 47.59, -122.3, 2),
        stationRow(7, 47.6, -122.3, 0.5),
        stationRow(3, 47.65, -122.3, 5),
      ]),
    );
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47.6, longitude: -122.3 }),
      ctx(),
    );

    expect(result.stations.map((s) => s.id)).toEqual([7, 4, 9, 3]);
  });

  it('orders bounding-box rows by their distance from the box center', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        stationRow(1, 47.7, -122.2, 12.5),
        stationRow(2, 47.601, -122.301, 0.2),
        stationRow(3, 47.5, -122.4, 9.1),
      ]),
    );
    const result = await findStations.handler(
      findStations.input.parse({ boundingbox: SEATTLE_BOX }),
      ctx(),
    );

    expect(result.stations.map((s) => [s.id, s.distance, s.distanceUnit])).toEqual([
      [2, 0.2, 'KM'],
      [3, 9.1, 'KM'],
      [1, 12.5, 'KM'],
    ]);
  });

  it('states how far a full radius pool reaches when a 501st record proves a remainder', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(ladder(501)));
    const c = ctx();
    await findStations.handler(
      findStations.input.parse({ latitude: 47.6, longitude: -122.3, maxresults: 3 }),
      c,
    );

    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('The retrieved stations reach 5 of the 25 KM radius.');
    expect(notice).toMatch(/narrow the radius or add filters/);
  });

  it('adds no reach clause when the pool came back without a remainder', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(ladder(500)));
    const c = ctx();
    await findStations.handler(
      findStations.input.parse({ latitude: 47.6, longitude: -122.3, maxresults: 3 }),
      c,
    );

    expect(String(getEnrichment(c).notice)).not.toContain('The retrieved stations');
  });

  it('states how much of a box a full pool covers, from its center against its farthest point', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(ladder(501)));
    const c = ctx();
    await findStations.handler(
      findStations.input.parse({ boundingbox: SEATTLE_BOX, maxresults: 3 }),
      c,
    );

    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain(
      'The retrieved stations cover the box out to 5 KM from its center (47.6, -122.3); its farthest point is 26.84 KM away.',
    );
    expect(notice).toMatch(/split the box into smaller boxes or add filters/);
  });

  it('adds the box reach clause when no retrieved station falls inside the box', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(ladder(501, 47.9)));
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({ boundingbox: SEATTLE_BOX }),
      c,
    );

    expect(result.stations).toEqual([]);
    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain('inside the box');
    expect(notice).toContain('The retrieved stations cover the box out to 5 KM from its center');
  });

  /**
   * Only the area test, unusable coordinates, and minchargepoints run on the retrieved pool; every
   * other filter ran upstream and chose which stations were retrieved. So an emptied pool is
   * recovered by relaxing minchargepoints when it was set, and otherwise only by the remainder's own
   * advice, never by relaxing "the other filters", which that advice contradicts ("add filters").
   */
  it.each([
    ['a box with no filter', { boundingbox: SEATTLE_BOX }, undefined],
    [
      'a box with minchargepoints',
      { boundingbox: SEATTLE_BOX, minchargepoints: 2 },
      'Relax minchargepoints.',
    ],
  ])(
    'recovers an emptied pool from %s without advice the remainder contradicts',
    async (_label, input, relax) => {
      fetchWithTimeout.mockResolvedValue(jsonResponse(ladder(501, 47.9)));
      const c = ctx();
      const result = await findStations.handler(findStations.input.parse(input), c);

      expect(result.stations).toEqual([]);
      const notice = String(getEnrichment(c).notice);
      expect(notice).toContain('split the box into smaller boxes or add filters');
      expect(notice).not.toContain('the other filters');
      if (relax) expect(notice).toContain(relax);
      else expect(notice).not.toContain('Relax');
    },
  );

  it('names the box center as a bounding box search point and never says its rows lack a distance', async () => {
    const { z } = await import('@cyanheads/mcp-ts-core');
    const { StationSchema } = await import('@/mcp-server/tools/definitions/_station-schema.js');
    const described = JSON.stringify([
      findStations.description,
      z.toJSONSchema(findStations.input),
      z.toJSONSchema(findStations.output),
      z.toJSONSchema(StationSchema),
    ]);

    expect(described).not.toMatch(/absent for bounding-box/i);
    for (const field of [
      findStations.input.shape.maxresults,
      findStations.input.shape.offset,
      findStations.input.shape.boundingbox,
      findStations.output.shape.stations,
      StationSchema.shape.distance,
    ]) {
      expect(field.description).toMatch(/center/i);
    }
  });
});

// https://github.com/cyanheads/openchargemap-mcp-server/issues/38
// https://github.com/cyanheads/openchargemap-mcp-server/issues/39
describe('openchargemap_find_stations usage fields and page-level provider terms', () => {
  const london = { latitude: 51.5, longitude: -0.13 };

  it('carries usage type ID, usage cost, address line 2, and provider ID on both surfaces', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([LONDON_POI]));
    const result = await runToolContract(findStations, london);
    const text = contentText(result);

    expect(result.structuredContent).toMatchObject({
      stations: [
        { usageTypeId: 6, usageCost: 'Free', dataProviderId: 1, address: { line2: 'Soho' } },
      ],
    });
    expect(text).toContain('Usage: Private - For Staff, Visitors or Customers (id 6)');
    expect(text).toContain('Usage cost: Free');
    expect(text).toContain('19-25 Broadwick Street, Soho, London');
    expect(text).toContain('Data provider: Open Charge Map Contributors (id 1)');
    // Contact fields are detail-only.
    expect(JSON.stringify(result.structuredContent)).not.toContain('020 7247 4114');
  });

  it('carries none of those keys when OCM has none, and passes usage type ID 0 through', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        SPARSE_POI,
        { ...LONDON_POI, UsageTypeID: 0, UsageType: { ID: 0, Title: '(Unknown)' } },
      ]),
    );
    const result = await runToolContract(findStations, london);
    // SPARSE_POI carries no distance, so it sorts after the London row.
    const [unknownUsage, sparse] = (result.structuredContent as { stations: object[] }).stations;

    for (const key of ['usageTypeId', 'usageCost', 'dataProviderId'])
      expect(sparse).not.toHaveProperty(key);
    expect((sparse as { address: object }).address).not.toHaveProperty('line2');
    expect(unknownUsage).toMatchObject({ usageTypeId: 0 });
    expect(contentText(result)).toContain('Usage: (Unknown) (id 0)');
  });

  it('lists each provider license once per page while every row keeps it in structuredContent', async () => {
    const license = 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)';
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([LONDON_POI, { ...LONDON_POI, ID: 2 }, { ...LONDON_POI, ID: 3 }]),
    );
    const result = await runToolContract(findStations, london);
    const text = contentText(result);

    expect(text.split(license)).toHaveLength(2);
    expect(text).toContain(
      `Data providers:\n  - Open Charge Map Contributors (id 1) · open data licensed: yes · Provider license: ${license}`,
    );
    expect(result.structuredContent).toMatchObject({
      stations: [1, 2, 3].map(() => ({ dataProviderLicense: license, isOpenDataLicensed: true })),
    });
  });
});

/** Every station of a contract result's structuredContent. */
function structuredStations(result: { structuredContent?: unknown }): Record<string, unknown>[] {
  return (result.structuredContent as { stations: Record<string, unknown>[] }).stations;
}

// https://github.com/cyanheads/openchargemap-mcp-server/issues/37
describe('openchargemap_find_stations along a route', () => {
  const seattlePortland = { route: SEATTLE_PORTLAND_ROUTE, distance: 5, levelid: 3 };
  const respondWithCorridor = () =>
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(SEATTLE_PORTLAND_ROWS.map((r) => routePoi(r.id, r.latitude, r.longitude))),
    );

  it.each([
    [
      'a center',
      { latitude: 47.6, longitude: -122.3 },
      'A route and a center (latitude + longitude) were supplied',
    ],
    ['a stray latitude', { latitude: 47.6 }, 'A route and a latitude were supplied'],
    ['a stray longitude', { longitude: -122.3 }, 'A route and a longitude were supplied'],
    ['a boundingbox', { boundingbox: SEATTLE_BOX }, 'A route and a boundingbox were supplied'],
    [
      'a latitude and a boundingbox',
      { latitude: 47.6, boundingbox: SEATTLE_BOX },
      'A route and a latitude and a boundingbox were supplied',
    ],
  ])('rejects a route sent with %s, naming what arrived', async (_label, extra, diagnosis) => {
    const error = await thrownBy(() =>
      findStations.handler(
        findStations.input.parse({ route: SEATTLE_PORTLAND_ROUTE, ...extra }),
        ctx(),
      ),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_location' },
    });
    expect(error.message).toContain(diagnosis);
    expect(error.message).toContain('provide exactly one location');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('accepts 2 to 500 route points and rejects fewer or more at the schema', () => {
    const points = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ latitude: 47 + i * 1e-3, longitude: -122 }));

    expect(findStations.input.safeParse({ route: points(1) }).success).toBe(false);
    expect(findStations.input.safeParse({ route: points(2) }).success).toBe(true);
    expect(findStations.input.safeParse({ route: points(500) }).success).toBe(true);
    expect(findStations.input.safeParse({ route: points(501) }).success).toBe(false);
    expect(
      findStations.input.safeParse({ route: [{ latitude: 91, longitude: 0 }, points(1)[0]] })
        .success,
    ).toBe(false);
  });

  it('pages a corridor in route order, Seattle first and Portland last, counting only corridor rows', async () => {
    respondWithCorridor();
    const first = ctx();
    const firstPage = await findStations.handler(
      findStations.input.parse({ ...seattlePortland, maxresults: 5 }),
      first,
    );
    const second = ctx();
    const secondPage = await findStations.handler(
      findStations.input.parse({ ...seattlePortland, maxresults: 5, offset: 5 }),
      second,
    );

    // 11 rows came back; 3 lie more than 5 km off the route and appear in no count.
    expect(getEnrichment(first)).toMatchObject({
      totalCount: 8,
      truncated: true,
      shown: 5,
      nextOffset: 5,
    });
    expect(getEnrichment(second)).toMatchObject({ totalCount: 8 });
    expect(getEnrichment(second)).not.toHaveProperty('nextOffset');
    expect(getEnrichment(second)).not.toHaveProperty('truncated');
    const stations = [...firstPage.stations, ...secondPage.stations];
    expect(stations.map((s) => s.id)).toEqual([
      380340, 380023, 379328, 379255, 249426, 233151, 376026, 6628,
    ]);
    const positions = stations.map((s) => s.routeDistance as number);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const station of stations) expect(station.offRouteDistance).toBeLessThanOrEqual(5);
    expect(firstPage.searchSummary).toBe(
      'Within 5 KM of a 4-point route (248.58 KM long); levelid=3; maxresults=5.',
    );
    expect(sentSearch().get('polyline')).toBe('waqaHr~siVz~mBv`nBbvnDjiFvtxBwvq@');
  });

  it('carries routeDistance and offRouteDistance on both surfaces only in route mode', async () => {
    respondWithCorridor();
    const route = await runToolContract(findStations, { ...seattlePortland, maxresults: 1 });
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const radius = await runToolContract(findStations, { latitude: 47.67, longitude: -122.38 });
    const box = await runToolContract(findStations, { boundingbox: SEATTLE_BOX });

    expect(structuredStations(route)[0]).toMatchObject({
      id: 380340,
      routeDistance: 0,
      offRouteDistance: 1.62,
      distanceUnit: 'KM',
    });
    expect(structuredStations(route)[0]).not.toHaveProperty('distance');
    expect(contentText(route)).toContain('Route: 0 KM along, 1.62 KM off it');
    for (const result of [radius, box]) {
      expect(structuredStations(result)[0]).toHaveProperty('distance');
      expect(structuredStations(result)[0]).not.toHaveProperty('routeDistance');
      expect(structuredStations(result)[0]).not.toHaveProperty('offRouteDistance');
      expect(contentText(result)).not.toContain('Route:');
    }
  });

  it('converts the corridor and reports both positions in miles', async () => {
    respondWithCorridor();
    const result = await runToolContract(findStations, {
      ...seattlePortland,
      distance: 3.1,
      distanceUnit: 'Miles',
    });

    const olympia = structuredStations(result).find((s) => s.id === 379255)!;
    expect(olympia).toMatchObject({ distanceUnit: 'Miles' });
    // 2.41 km off the route, measured independently, is 1.50 miles.
    expect(Math.abs((olympia.offRouteDistance as number) - 2.41 / 1.609344)).toBeLessThan(0.05);
    expect(contentText(result)).toContain(
      `Route: ${olympia.routeDistance} Miles along, ${olympia.offRouteDistance} Miles off it`,
    );
    expect(contentText(result)).toContain(
      'Within 3.1 Miles of a 4-point route (154.47 Miles long)',
    );
    expect(sentSearch().get('distanceunit')).toBe('KM');
  });

  it('says route matches arrive newest first when a 501st record proves a remainder', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(
        Array.from({ length: 501 }, (_, i) => routePoi(10_000 - i, 47.6062, -122.3321 - i * 1e-4)),
      ),
    );
    const c = ctx();
    await findStations.handler(findStations.input.parse({ ...seattlePortland, maxresults: 3 }), c);

    const notice = String(getEnrichment(c).notice);
    expect(notice).toContain(
      'Route matches arrive newest first (by descending station ID), so stations added earlier may be missing anywhere along the route.',
    );
    expect(notice).toContain(
      'search shorter stretches of the route, narrow distance, or add filters',
    );
    expect(notice).not.toContain('The retrieved stations');
  });

  it('names the corridor when no retrieved station lies within it', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(Array.from({ length: 501 }, (_, i) => routePoi(10_000 - i, 47.7, -122.3))),
    );
    const c = ctx();
    const result = await findStations.handler(findStations.input.parse(seattlePortland), c);

    expect(result.stations).toEqual([]);
    expect(String(getEnrichment(c).notice)).toContain(
      'No station this search retrieved lay within 5 KM of the route and met the filters.',
    );
  });

  it('reports an empty corridor with the route echoed in the recovery notice', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const c = ctx();
    await findStations.handler(findStations.input.parse(seattlePortland), c);

    expect(String(getEnrichment(c).notice)).toContain(
      'No charging stations matched Within 5 KM of a 4-point route (248.58 KM long)',
    );
  });

  it('lets a route the service cannot search fail invalid_location with its own recovery', async () => {
    const result = await runToolContract(findStations, {
      route: [
        { latitude: 64.5, longitude: 177 },
        { latitude: 64.5, longitude: -177 },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_location' } },
    });
    expect(contentText(result)).toContain('two routes, one on each side');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('fails a timed-out route search as not retryable with its own next move, on both surfaces', async () => {
    fetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.Timeout, 'Fetch timed out.', { errorSource: 'FetchTimeout' }),
    );
    const hint =
      'Send the route with fewer points, or search a stretch of it with a center or a boundingbox.';
    const route = await runToolContract(findStations, seattlePortland);

    expect(route.isError).toBe(true);
    expect(route.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: false, recovery: { hint } },
      },
    });
    expect(contentText(route)).toContain(hint);
    expect(contentText(route)).toContain('not retryable');

    // A center search that times out keeps the declared retry-later recovery.
    const radius = await runToolContract(findStations, { latitude: 47.6, longitude: -122.3 });
    expect(radius.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'upstream_unavailable',
          retryable: true,
          recovery: { hint: declaredRecovery('upstream_unavailable') },
        },
      },
    });
  });

  it('applies countrycode and the other filters to a route search unchanged', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await findStations.handler(
      findStations.input.parse({ ...seattlePortland, countrycode: 'ca', minpowerkw: 50 }),
      ctx(),
    );

    expect(sentSearch().get('countrycode')).toBe('CA');
    expect(sentSearch().get('minpowerkw')).toBe('50');
    expect(sentSearch().get('levelid')).toBe('3');
    expect(sentSearch().has('polyline')).toBe(true);
  });
});
