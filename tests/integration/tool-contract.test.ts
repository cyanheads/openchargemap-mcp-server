/**
 * @fileoverview Conformance coverage for every tool's public `CallToolResult` envelope — the
 * surface a client actually receives, not the handler return value. `toolContractSuite` drives
 * input parsing, the real handler, output parsing, `format()`, enrichment, and collected content,
 * then asserts the success envelope validates against the declared output schema and each failure
 * lands the dual-surface error envelope with the contract's code and `data.reason`.
 * @module tests/integration/tool-contract.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, expect, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    withRetry: (fn: () => unknown) => fn(),
  };
});

const { findStations } = await import('@/mcp-server/tools/definitions/find-stations.tool.js');
const { getStation } = await import('@/mcp-server/tools/definitions/get-station.tool.js');
const { getStationComments } = await import(
  '@/mcp-server/tools/definitions/get-station-comments.tool.js'
);
const { lookupReference } = await import('@/mcp-server/tools/definitions/lookup-reference.tool.js');
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { FULL_POI, FULL_POI_DETAIL, jsonResponse } = await import('../fixtures/ocm.js');

const serverConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};

/** OCM answers an unknown chargepointid with HTTP 200 and `[]` — the not_found path. */
const MISSING_STATION_ID = 999_999;

beforeEach(async () => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation((url: string) => {
    const params = new URL(String(url)).searchParams;
    if (params.get('chargepointid') === String(MISSING_STATION_ID)) {
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.resolve(
      jsonResponse(params.get('verbose') === 'true' ? [FULL_POI_DETAIL] : [FULL_POI]),
    );
  });
  await initReferenceDataService(serverConfig);
  initOpenChargeMapService(serverConfig);
});

const context = { tenantId: 'contract' };

toolContractSuite(findStations, {
  context,
  success: [
    {
      name: 'returns a schema-valid envelope for a radius search',
      input: { latitude: 47.6062, longitude: -122.3321, maxresults: 5 },
      assert: (result) => {
        expect(result.content?.[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('AMLI Mark24'),
        });
      },
    },
  ],
  errors: [
    {
      name: 'rejects a search with neither a center nor a bounding box',
      input: { maxresults: 5 },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'invalid_location',
    },
  ],
});

toolContractSuite(getStation, {
  context,
  success: [
    {
      name: 'returns a schema-valid envelope for a station detail lookup',
      input: { id: FULL_POI.ID, includeComments: true },
      assert: (result) => {
        expect(result.content?.[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('$0.30/kWh'),
        });
      },
    },
  ],
  errors: [
    {
      name: 'reports an unknown station id as not_found',
      input: { id: MISSING_STATION_ID },
      code: JsonRpcErrorCode.NotFound,
      reason: 'not_found',
    },
  ],
});

toolContractSuite(getStationComments, {
  context,
  success: [
    {
      name: 'returns a schema-valid envelope for station check-ins',
      input: { id: FULL_POI.ID, maxresults: 5 },
      assert: (result) => {
        const structured = result.structuredContent as {
          comments: Record<string, unknown>[];
        };
        // The check-in outcome and its verdict both reach the wire.
        expect(structured.comments[0]).toMatchObject({
          checkinStatus: 'Failed to Charge (Equipment Not Operational)',
          checkinStatusId: 20,
          checkinStatusIsPositive: false,
        });
        expect(result.content?.[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('Failed to Charge (Equipment Not Operational)'),
        });
        expect(result.content?.[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('good visit: no'),
        });
      },
    },
  ],
  errors: [
    {
      name: 'reports an unknown station id as not_found',
      input: { id: MISSING_STATION_ID },
      code: JsonRpcErrorCode.NotFound,
      reason: 'not_found',
    },
  ],
});

toolContractSuite(lookupReference, {
  context,
  success: [
    {
      name: 'returns a schema-valid envelope for a connector lookup',
      input: { category: 'connectiontypes', query: 'CCS' },
    },
  ],
  errors: [
    {
      name: 'reports an unmatched query as no_match',
      input: { category: 'connectiontypes', query: 'zzzz-no-such-connector' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'no_match',
    },
  ],
});
