/**
 * @fileoverview Tests for openchargemap_get_station_comments — comments + registry status header
 * (headline goal), empty-comments-is-not-an-error, the not_found case, maxresults trimming, and the
 * auth error path (fetch mock THROWS on non-OK).
 * @module tests/tools/get-station-comments.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

const { getStationComments } = await import(
  '@/mcp-server/tools/definitions/get-station-comments.tool.js'
);
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const { FULL_POI, FULL_POI_DETAIL, jsonResponse } = await import('../fixtures/ocm.js');

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

const ctx = () => createMockContext({ tenantId: 'test', errors: getStationComments.errors });

describe('openchargemap_get_station_comments', () => {
  it('returns comments newest-first alongside the registry status header (headline goal)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      ctx(),
    );

    expect(result.stationId).toBe(145452);
    expect(result.registryStatus).toBe('Temporarily Unavailable');
    expect(result.isOperational).toBe(true);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]!.dateCreated).toBe('2025-06-01T10:00:00Z'); // newest first
    expect(result.reliabilityNote).toContain('fault');
    expect(result.attribution).toContain('CC BY 4.0');
  });

  it('returns comments: [] (not an error) for a station with no check-ins', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI])); // FULL_POI has no UserComments
    const c = ctx();
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      c,
    );

    expect(result.comments).toEqual([]);
    const enrichment = getEnrichment(c) as { notice?: string };
    expect(enrichment.notice).toContain('Absence of reports is not evidence');
  });

  it('trims to maxresults (newest first) and discloses truncation', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const c = ctx();
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452, maxresults: 1 }),
      c,
    );

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]!.dateCreated).toBe('2025-06-01T10:00:00Z');
    const enrichment = getEnrichment(c) as { truncated?: boolean; shown?: number; cap?: number };
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.cap).toBe(1);
  });

  it('always requests comments embedded in the POI (includecomments=true)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    await getStationComments.handler(getStationComments.input.parse({ id: 145452 }), ctx());
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('includecomments=true');
  });

  it('throws not_found for a non-existent station (empty array)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await expect(
      getStationComments.handler(getStationComments.input.parse({ id: 99999991 }), ctx()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
  });

  it('maps a 403 to auth_failed (fetch mock throws)', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Forbidden, 'HTTP 403'));
    await expect(
      getStationComments.handler(getStationComments.input.parse({ id: 1 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'auth_failed' },
    });
  });
});
