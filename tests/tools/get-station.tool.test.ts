/**
 * @fileoverview Tests for openchargemap_get_station — verbose detail fetch (headline goal),
 * the not_found empty-array case, inline comments + reliability note, sparse tolerance, and the
 * auth/unavailable error paths (fetch mock THROWS on non-OK).
 * @module tests/tools/get-station.tool.test
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
    withRetry: (fn: () => unknown) => fn(),
  };
});

const { getStation } = await import('@/mcp-server/tools/definitions/get-station.tool.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const { FULL_POI_DETAIL, SPARSE_POI, jsonResponse } = await import('../fixtures/ocm.js');

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

afterEach(() => vi.clearAllMocks());

const ctx = () => createMockContext({ tenantId: 'test', errors: getStation.errors });

describe('openchargemap_get_station', () => {
  it('returns the full detail record for a numeric id (headline goal)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());

    expect(result.station.id).toBe(145452);
    expect(result.station.generalComments).toBe('Located in the parking garage, level P1.');
    expect(result.station.usageCost).toBe('$0.30/kWh');
    expect(result.station.numberOfPoints).toBe(2);
    expect(result.station.media?.[0]?.url).toBe('https://example.com/photo.jpg');
    expect(result.attribution).toContain('CC BY 4.0');
  });

  it('uses verbose=true on the detail request', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('verbose=true');
    expect(String(url)).toContain('chargepointid=145452');
  });

  it('includes comments inline and computes a reliability note when faults are present', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(
      getStation.input.parse({ id: 145452, includeComments: true }),
      ctx(),
    );

    expect(result.station.comments).toHaveLength(2);
    // Newest first.
    expect(result.station.comments?.[0]?.dateCreated).toBe('2025-06-01T10:00:00Z');
    expect(result.reliabilityNote).toContain('fault');
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('includecomments=true');
  });

  it('throws not_found when OCM returns an empty array (HTTP 200 + [])', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await expect(
      getStation.handler(getStation.input.parse({ id: 99999991 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('tolerates a sparse detail payload and validates against the output schema', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([SPARSE_POI]));
    const result = await getStation.handler(getStation.input.parse({ id: 253415 }), ctx());
    expect(result.station.isOperational).toBeUndefined();
    expect(result.station.generalComments).toBeUndefined();
    expect(result).toEqual(expect.schemaMatching(getStation.output));
  });

  it('maps a 403 to auth_failed (fetch mock throws)', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Forbidden, 'HTTP 403'));
    await expect(
      getStation.handler(getStation.input.parse({ id: 1 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'auth_failed' },
    });
  });

  it('format() renders detail fields, comments, and reliability note', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(
      getStation.input.parse({ id: 145452, includeComments: true }),
      ctx(),
    );
    const text = (getStation.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Usage cost: $0.30/kWh');
    expect(text).toContain('Reliability:');
    expect(text).toContain('CC BY 4.0');
  });
});
