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
    if (params.get('verbose') === 'true') return Promise.resolve(jsonResponse([FULL_POI_DETAIL]));
    // Two search results, so a maxresults-1 call exercises the truncation/continuation envelope.
    return Promise.resolve(jsonResponse([FULL_POI, { ...FULL_POI, ID: 145_453 }]));
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
    {
      // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
      name: 'carries continuation metadata on both surfaces when a page is truncated',
      input: { latitude: 47.6062, longitude: -122.3321, maxresults: 1 },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          totalCount: 2,
          truncated: true,
          shown: 1,
          cap: 1,
          nextOffset: 1,
          notice: expect.stringContaining('offset 1'),
        });
        // The enrichment trailer mirrors the notice into content[] for format()-only clients, and
        // names what totalCount counts — the framework's default renders a bare "N total", which
        // reads as a registry-wide match total this tool cannot know.
        expect(result.content?.at(-1)).toMatchObject({
          type: 'text',
          text: expect.stringContaining('offset 1'),
        });
        expect(result.content?.at(-1)?.text).toContain('2 matching stations retrieved');
        expect(result.content?.at(-1)?.text).not.toContain('**2 total**');
      },
    },
    {
      // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
      name: 'returns the second page for the reported offset',
      input: { latitude: 47.6062, longitude: -122.3321, maxresults: 1, offset: 1 },
      assert: (result) => {
        const structured = result.structuredContent as { stations: { id: number }[] };
        expect(structured.stations.map((s) => s.id)).toEqual([145_453]);
        expect(result.structuredContent).not.toHaveProperty('nextOffset');
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
    {
      // https://github.com/cyanheads/openchargemap-mcp-server/issues/17
      name: 'rejects a bounding box carrying a stray latitude rather than dropping it',
      input: {
        latitude: 47.6062,
        boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2 },
        maxresults: 2,
      },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'invalid_location',
    },
    {
      // https://github.com/cyanheads/openchargemap-mcp-server/issues/17
      name: 'rejects a bounding box carrying a stray longitude rather than dropping it',
      input: {
        longitude: -122.3321,
        boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2 },
        maxresults: 2,
      },
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
      input: { id: FULL_POI.ID, maxresults: 5, offset: 0 },
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
    {
      // https://github.com/cyanheads/openchargemap-mcp-server/issues/16
      name: 'renders the page count against the station total when a page is capped',
      input: { id: FULL_POI.ID, maxresults: 1 },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({ totalComments: 2, totalCount: 2 });
        expect(result.content?.[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('1 of 2 comment(s), newest first:'),
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
      assert: (result) => {
        // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
        // This suite runs with referenceRefresh off, so the vintage on the wire is the bundle's.
        expect(result.structuredContent).toMatchObject({ source: 'bundled' });
        expect(result.content?.[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('Reference data: bundled (captured '),
        });
      },
    },
    {
      // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
      name: 'carries browse continuation metadata on both surfaces',
      input: { category: 'operators', limit: 5 },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          truncated: true,
          shown: 5,
          cap: 5,
          nextOffset: 5,
          notice: expect.stringContaining('offset 5'),
        });
        expect(result.content?.at(-1)).toMatchObject({
          type: 'text',
          text: expect.stringContaining('offset 5'),
        });
      },
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
