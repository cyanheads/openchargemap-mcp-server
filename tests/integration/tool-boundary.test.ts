/**
 * @fileoverview Offline integration tests for all tools through the real service/normalization
 * boundary, with only the Open Charge Map HTTP request faked.
 * @module tests/integration/tool-boundary.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();
const clampCount = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: () => ({ add: clampCount }),
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
const { getServerConfig, resetServerConfig } = await import('@/config/server-config.js');
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
  clampCount.mockReset();
  vi.stubEnv('OPENCHARGEMAP_CLAMP_LIMITS', 'true');
  fetchWithTimeout.mockImplementation((url: string) => {
    const request = new URL(String(url));
    return Promise.resolve(
      jsonResponse(request.searchParams.get('verbose') === 'true' ? [FULL_POI_DETAIL] : [FULL_POI]),
    );
  });
  await initReferenceDataService(serverConfig);
  initOpenChargeMapService(serverConfig);
});

afterEach(() => vi.unstubAllEnvs());

const toolContext = <const TErrors extends readonly ErrorContract[] | undefined>(errors: TErrors) =>
  createMockContext({ tenantId: 'integration', errors });

describe('tool integration at the OCM boundary', () => {
  it('validates the clamp switch at startup without boolean truthiness coercion', () => {
    vi.stubEnv('OPENCHARGEMAP_API_KEY', 'test-key');
    vi.stubEnv('OPENCHARGEMAP_CLAMP_LIMITS', 'not-a-boolean');
    resetServerConfig();
    expect(getServerConfig).toThrow('OPENCHARGEMAP_CLAMP_LIMITS');
    resetServerConfig();
  });
  it('rejects oversize values with the compatibility switch off and invalid sizes in both modes', async () => {
    for (const mode of ['true', 'false']) {
      vi.stubEnv('OPENCHARGEMAP_CLAMP_LIMITS', mode);
      for (const size of [0, -1, 1.5, ...(mode === 'false' ? [201] : [])]) {
        for (const result of [
          await runToolContract(findStations, { latitude: 47, longitude: -122, maxresults: size }),
          await runToolContract(getStationComments, { id: 145452, maxresults: size }),
          await runToolContract(lookupReference, { category: 'countries', limit: size }),
        ]) {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: { data: { reason: 'invalid_arguments' } },
          });
          expect(JSON.stringify(result.content)).toContain('invalid_arguments');
        }
      }
    }
    expect(clampCount).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('logs and counts each clamp once with bounded labels', async () => {
    const context = createMockContext({ errors: findStations.errors });
    const log = vi.spyOn(context.log, 'notice');
    await findStations.handler(
      findStations.input.parse({ latitude: 47, longitude: -122, maxresults: 201 }),
      context,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(clampCount).toHaveBeenCalledExactlyOnceWith(1, {
      tool: 'find_stations',
      parameter: 'maxresults',
    });
  });

  it('advertises open page-size upper bounds and per-filter integer minima', () => {
    const search = z.toJSONSchema(findStations.input);
    expect(search.properties?.maxresults).toHaveProperty('maximum', Number.MAX_SAFE_INTEGER);
    expect(search.properties?.maxresults).toMatchObject({ minimum: 1, type: 'integer' });
    for (const [definition, field] of [
      [lookupReference, 'limit'],
      [getStationComments, 'maxresults'],
    ] as const) {
      const schema = z.toJSONSchema(definition.input);
      expect(schema.properties?.[field]).toHaveProperty('maximum', Number.MAX_SAFE_INTEGER);
      expect(schema.properties?.[field]).toMatchObject({ minimum: 1, type: 'integer' });
    }
    for (const field of [
      'connectiontypeid',
      'usagetypeid',
      'statustypeid',
      'operatorid',
      'levelid',
    ]) {
      const minimum = ['operatorid', 'levelid'].includes(field) ? 1 : 0;
      expect(search.properties?.[field]).toMatchObject({
        anyOf: [
          { type: 'integer', minimum },
          { type: 'array', minItems: 1, items: { type: 'integer', minimum } },
        ],
      });
    }
  });

  it.each([500, 501])(
    'reports sentinel-confirmed remainder honestly after local filtering (%s raw rows)',
    async (size) => {
      fetchWithTimeout.mockResolvedValue(
        jsonResponse(
          Array.from({ length: size }, (_, index) => ({
            ...FULL_POI,
            ID: index,
            NumberOfPoints: 1,
          })),
        ),
      );
      const result = await runToolContract(findStations, {
        latitude: 47,
        longitude: -122,
        minchargepoints: 20,
        countrycode: 'zz',
        maxresults: 201,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ stations: [], totalCount: 0 });
      const text = JSON.stringify(result.content);
      for (const token of ['ZZ', '201', '200']) expect(text).toContain(token);
      if (size === 501) {
        expect(result.structuredContent).toMatchObject({
          truncated: true,
          notice: expect.stringContaining('No station this search retrieved met the filters'),
        });
        expect(text).toContain('holds more stations');
      } else {
        expect(result.structuredContent).not.toHaveProperty('truncated');
        expect(text).toContain('No charging stations matched');
        expect(text).not.toContain('holds more stations');
      }
    },
  );

  it('keeps unknown-country and clamp notices when an offset exhausts the retrieved pool', async () => {
    const result = await runToolContract(findStations, {
      latitude: 47,
      longitude: -122,
      offset: 2,
      countrycode: 'ZZ',
      maxresults: 201,
    });
    expect(result.structuredContent).toMatchObject({ stations: [], totalCount: 1 });
    for (const token of ['ZZ', '201', '200', 'past the end']) {
      expect(JSON.stringify(result.content)).toContain(token);
      expect(result.structuredContent).toHaveProperty('notice', expect.stringContaining(token));
    }
  });

  it('caps available result pages and keeps clamp notices alongside continuation', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(Array.from({ length: 501 }, (_, index) => ({ ...FULL_POI, ID: index + 1 }))),
    );
    const result = await runToolContract(findStations, {
      latitude: 47,
      longitude: -122,
      maxresults: 201,
      countrycode: 'zz',
    });
    expect(result.structuredContent).toMatchObject({
      stations: expect.any(Array),
      totalCount: 500,
      shown: 200,
      cap: 200,
      nextOffset: 200,
    });
    expect(findStations.output.parse(result.structuredContent).stations).toHaveLength(200);
    for (const token of ['201', '200', 'ZZ', 'offset 200']) {
      expect(JSON.stringify(result.content)).toContain(token);
      expect(result.structuredContent).toHaveProperty('notice', expect.stringContaining(token));
    }
  });

  it('rejects negative, fractional and empty ID filters while retaining positive-only operator and level minima', async () => {
    for (const field of [
      'connectiontypeid',
      'usagetypeid',
      'statustypeid',
      'operatorid',
      'levelid',
    ]) {
      for (const value of [
        -1,
        1.5,
        [],
        [-1],
        [1.5],
        ...(['operatorid', 'levelid'].includes(field) ? [0, [0]] : []),
      ]) {
        const result = await runToolContract(findStations, {
          latitude: 47,
          longitude: -122,
          [field]: value,
        });
        expect(result.isError).toBe(true);
      }
    }
  });

  it('returns empty search success with composed unknown-country and clamp recovery on both surfaces', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const result = await runToolContract(findStations, {
      latitude: -40,
      longitude: -140,
      countrycode: 'zz',
      maxresults: 201,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      stations: [],
      totalCount: 0,
      searchSummary: expect.stringContaining('countrycode=ZZ (unrecognized, not applied)'),
    });
    const text = JSON.stringify(result.content);
    for (const token of ['201', '200', 'ZZ', 'without a country restriction', 'Widen'])
      expect(text).toContain(token);
    expect(
      new URL(String(fetchWithTimeout.mock.calls[0]![0])).searchParams.has('countrycode'),
    ).toBe(false);
  });

  it.each(['connectiontypeid', 'usagetypeid', 'statustypeid'] as const)(
    'forwards zero-valued %s in scalar and array form',
    async (field) => {
      for (const value of [0, [0, 1]]) {
        const result = await runToolContract(findStations, {
          latitude: 47,
          longitude: -122,
          [field]: value,
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          searchSummary: expect.stringContaining(`${field}=0`),
        });
        expect(JSON.stringify(result.content)).toContain(`${field}=0`);
        expect(
          new URL(String(fetchWithTimeout.mock.calls.at(-1)![0])).searchParams.get(field),
        ).toBe(String(value));
      }
    },
  );

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'handles prototype query %s as an ordinary empty success',
    async (query) => {
      const result = await runToolContract(lookupReference, { category: 'connectiontypes', query });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        matches: [],
        totalCount: 0,
        notice: expect.stringContaining(query),
      });
      expect(JSON.stringify(result.content)).toContain(query);
      expect(JSON.stringify(result.content)).toContain('browse');
    },
  );

  it('clamps comment and reference pages while preserving their ordinary outputs', async () => {
    const comments = await runToolContract(getStationComments, { id: 145452, maxresults: 101 });
    const reference = await runToolContract(lookupReference, { category: 'countries', limit: 101 });
    for (const result of [comments, reference]) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining('101') });
      expect(JSON.stringify(result.content)).toContain('100');
    }
  });

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
