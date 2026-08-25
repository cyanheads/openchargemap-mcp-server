/**
 * @fileoverview Offline integration tests for all tools through the real service/normalization
 * boundary, with only the Open Charge Map HTTP request faked.
 * @module tests/integration/tool-boundary.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(async () => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation((url: string) => {
    const request = new URL(String(url));
    return Promise.resolve(
      jsonResponse(request.searchParams.get('verbose') === 'true' ? [FULL_POI_DETAIL] : [FULL_POI]),
    );
  });
  await initReferenceDataService(serverConfig);
  initOpenChargeMapService(serverConfig);
});

const toolContext = <const TErrors extends readonly ErrorContract[] | undefined>(errors: TErrors) =>
  createMockContext({ tenantId: 'integration', errors });

describe('tool integration at the OCM boundary', () => {
  it('runs all four tools offline with schema-valid structured and text output', async () => {
    const found = await findStations.handler(
      findStations.input.parse({ latitude: 47.6062, longitude: -122.3321, maxresults: 5 }),
      toolContext(findStations.errors),
    );
    const station = await getStation.handler(
      getStation.input.parse({ id: 145452, includeComments: true }),
      toolContext(getStation.errors),
    );
    const comments = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452, maxresults: 5 }),
      toolContext(getStationComments.errors),
    );
    const reference = await lookupReference.handler(
      lookupReference.input.parse({ category: 'connectiontypes', query: 'CCS' }),
      toolContext(lookupReference.errors),
    );

    expect(found).toEqual(expect.schemaMatching(findStations.output));
    expect(station).toEqual(expect.schemaMatching(getStation.output));
    expect(comments).toEqual(expect.schemaMatching(getStationComments.output));
    expect(reference).toEqual(expect.schemaMatching(lookupReference.output));

    expect((findStations.format!(found)[0] as { text: string }).text).toContain('AMLI Mark24');
    expect((getStation.format!(station)[0] as { text: string }).text).toContain('$0.30/kWh');
    expect((getStationComments.format!(comments)[0] as { text: string }).text).toContain(
      'Connector 1 would not start a session.',
    );
    expect((lookupReference.format!(reference)[0] as { text: string }).text).toContain(
      'connectiontypeid',
    );
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  });

  it('keeps the lookup_reference path fully offline', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', query: 'ChargePoint' }),
      toolContext(lookupReference.errors),
    );

    expect(result.matches.some((match) => match.id === 5)).toBe(true);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
