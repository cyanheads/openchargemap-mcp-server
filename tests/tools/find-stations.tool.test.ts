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
  it.skip('rejects empty ID filter arrays instead of silently disabling the filter', () => {
    expect(() =>
      findStations.input.parse({ latitude: 47, longitude: -122, levelid: [] }),
    ).toThrow();
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
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const c = ctx();
    const result = await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 1 }),
      c,
    );

    expect(result).toEqual(expect.schemaMatching(findStations.output));
    expect(getEnrichment(c)).toMatchObject({
      totalCount: 1,
      truncated: true,
      shown: 1,
      cap: 1,
    });
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/12
  it.skip('names whether both location modes or neither were supplied', async () => {
    const neither = findStations
      .handler(findStations.input.parse({}), ctx())
      .catch((error) => error);
    const both = findStations
      .handler(
        findStations.input.parse({
          latitude: 47,
          longitude: -122,
          boundingbox: { sw_lat: 46, sw_lng: -123, ne_lat: 48, ne_lng: -121 },
        }),
        ctx(),
      )
      .catch((error) => error);

    await expect(neither).resolves.toMatchObject({ message: expect.stringMatching(/provide/i) });
    await expect(both).resolves.toMatchObject({ message: expect.stringMatching(/not both/i) });
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/12
  it.skip('documents both HTTP 401 and 403 in the auth_failed contract', () => {
    const auth = findStations.errors?.find((entry) => entry.reason === 'auth_failed');
    expect(auth?.when).toContain('401');
    expect(auth?.when).toContain('403');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/8
  it.skip('does not report no_stations when a capped page is emptied by local filters', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
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
    expect(getEnrichment(c)).toMatchObject({ truncated: true });
  });
});
