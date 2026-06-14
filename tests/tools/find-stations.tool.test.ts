/**
 * @fileoverview Tests for openchargemap_find_stations — headline radius search, bounding-box mode,
 * the invalid-location and no-stations contract errors, sparse-payload tolerance, and the upstream
 * auth/unavailable error paths (the fetch mock THROWS on non-OK, mirroring the real framework).
 * @module tests/tools/find-stations.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { FULL_POI, SPARSE_POI, jsonResponse } = await import('../fixtures/ocm.js');

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
      data: { reason: 'no_stations' },
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

  it('maps a 403 to auth_failed (fetch mock throws, as the real framework does on non-OK)', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Forbidden, 'HTTP 403'));
    const input = findStations.input.parse({ latitude: 47, longitude: -122 });
    await expect(findStations.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'auth_failed' },
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
});
