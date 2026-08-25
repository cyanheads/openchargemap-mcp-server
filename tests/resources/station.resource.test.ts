/**
 * @fileoverview Tests for the openchargemap://station/{id} resource — full record by id (the
 * detail tool's twin) and the not_found empty-array case. Fetch mock returns fixtures.
 * @module tests/resources/station.resource.test
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

const { stationResource } = await import('@/mcp-server/resources/definitions/station.resource.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const { FULL_POI_DETAIL, jsonResponse } = await import('../fixtures/ocm.js');

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

const ctx = (uri: string) =>
  createMockContext({ tenantId: 'test', uri: new URL(uri), errors: stationResource.errors });

describe('openchargemap://station/{id}', () => {
  it('returns the full station record (with comments) by numeric id', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await stationResource.handler(
      { id: '145452' },
      ctx('openchargemap://station/145452'),
    );
    expect(result.station.id).toBe(145452);
    expect(result.station.comments).toHaveLength(2);
    expect(result.attribution).toContain('CC BY 4.0');
    // The framework parses the handler return against `output` before it reaches the client, so a
    // shape the schema rejects is a failed read, not a lenient one.
    expect(stationResource.output?.safeParse(result).success).toBe(true);
  });

  it('advertises a cache lifetime no longer than the service result cache', () => {
    // A client may hold the record for this long; the service serves its own cached copy for 600s,
    // so a longer hint would let a reader see something a second read would not have returned.
    expect(stationResource.cacheHint?.ttlMs).toBe(600_000);
  });

  it('throws not_found when the station does not exist (empty array)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await expect(
      stationResource.handler({ id: '99999991' }, ctx('openchargemap://station/99999991')),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
  });
});
