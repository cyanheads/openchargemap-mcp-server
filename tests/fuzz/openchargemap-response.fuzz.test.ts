/**
 * @fileoverview Deterministic fuzz coverage for sparse, empty, and malformed OCM response bodies.
 * @module tests/fuzz/openchargemap-response.fuzz.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawPoi } from '@/services/openchargemap/types.js';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    withRetry: (fn: () => unknown) => fn(),
  };
});

const { OpenChargeMapService } = await import('@/services/openchargemap/openchargemap-service.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { findStations } = await import('@/mcp-server/tools/definitions/find-stations.tool.js');
const { getStation } = await import('@/mcp-server/tools/definitions/get-station.tool.js');
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const { jsonResponse } = await import('../fixtures/ocm.js');

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

const ctx = (seed: number) =>
  createMockContext({ tenantId: `fuzz-${seed}`, errors: findStations.errors });

/** The real OCM StatusTypes vocabulary, so the availability classifier sees its live inputs. */
const STATUS_IDS = [0, 10, 20, 30, 50, 75, 100, 150, 200, 210];

/** Small seeded generator so failures reproduce without a property-testing dependency. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function sparsePoi(seed: number): RawPoi {
  const next = random(seed);
  const include = () => next() > 0.45;
  return {
    ...(include() ? { ID: seed } : {}),
    ...(include() ? { UUID: `fuzz-${seed}` } : {}),
    AddressInfo: {
      ...(include() ? { Title: `Station ${seed}` } : {}),
      Latitude: next() * 180 - 90,
      Longitude: next() * 360 - 180,
      ...(include() ? { Town: `Town ${seed}` } : {}),
      ...(include() ? { Distance: next() * 500, DistanceUnit: next() > 0.5 ? 1 : 2 } : {}),
    },
    ...(include()
      ? {
          Connections: [
            {
              ...(include() ? { ConnectionTypeID: Math.floor(next() * 50) + 1 } : {}),
              ...(include() ? { PowerKW: next() > 0.2 ? next() * 350 : null } : {}),
              ...(include() ? { Quantity: next() > 0.2 ? Math.floor(next() * 12) + 1 : null } : {}),
            },
          ],
        }
      : {}),
    ...(include() ? { StatusTypeID: STATUS_IDS[Math.floor(next() * STATUS_IDS.length)] } : {}),
    ...(include()
      ? {
          StatusType: {
            ...(include() ? { ID: STATUS_IDS[Math.floor(next() * STATUS_IDS.length)] } : {}),
            ...(include() ? { Title: next() > 0.5 ? 'Operational' : 'Unknown' } : {}),
            ...(include() ? { IsOperational: next() > 0.5 } : {}),
          },
        }
      : {}),
    ...(include()
      ? {
          UsageType: {
            ...(include() ? { Title: 'Public' } : {}),
            ...(include() ? { IsPayAtLocation: next() > 0.5 } : { IsPayAtLocation: null }),
            ...(include() ? { IsMembershipRequired: next() > 0.5 } : {}),
          },
        }
      : {}),
    ...(include() ? { IsRecentlyVerified: next() > 0.5 } : {}),
  };
}

/** Sparse comment rows: every combination of missing text, rating, and check-in outcome. */
function sparseComments(seed: number): NonNullable<RawPoi['UserComments']> {
  const next = random(seed * 7 + 1);
  const include = () => next() > 0.45;
  return [1, 2, 3].map((n) => ({
    ID: n,
    ...(include() ? { CommentType: { ID: 10, Title: 'General Comment' } } : {}),
    ...(include() ? { CheckinStatusTypeID: n * 10 } : {}),
    ...(include()
      ? {
          CheckinStatusType: {
            ...(include() ? { ID: n * 10 } : {}),
            ...(include() ? { Title: `Outcome ${n}` } : {}),
            ...(include() ? { IsPositive: next() > 0.5 } : { IsPositive: null }),
          },
        }
      : {}),
    ...(include() ? { Comment: `note ${n}` } : { Comment: null }),
    ...(include() ? { Rating: Math.floor(next() * 5) + 1 } : { Rating: null }),
    ...(include() ? { DateCreated: `2025-0${n}-01T00:00:00Z` } : {}),
  }));
}

describe('OCM response parser fuzzing', () => {
  it('normalizes 100 deterministic sparse station payloads without network access', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      fetchWithTimeout.mockResolvedValueOnce(jsonResponse([sparsePoi(seed)]));
      const service = new OpenChargeMapService(serverConfig);
      const result = await service.searchPois(
        { maxresults: 1, latitude: 0, longitude: 0 },
        ctx(seed),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: expect.any(Number),
        uuid: expect.any(String),
        title: expect.any(String),
        address: {
          latitude: expect.any(Number),
          longitude: expect.any(Number),
        },
        connections: expect.any(Array),
      });
    }
  });

  it('renders 60 deterministic sparse comment payloads through the detail surface', async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const poi = { ...sparsePoi(seed), ID: seed, UserComments: sparseComments(seed) };
      fetchWithTimeout.mockResolvedValueOnce(jsonResponse([poi]));
      const result = await getStation.handler(
        getStation.input.parse({ id: seed, includeComments: true }),
        createMockContext({ tenantId: `fuzz-detail-${seed}`, errors: getStation.errors }),
      );

      expect(result).toEqual(expect.schemaMatching(getStation.output));
      // Every row survives normalization; only the text list may skip the empty ones.
      expect(result.station.comments).toHaveLength(3);
      const text = (getStation.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Comments');
      expect(text).not.toContain('undefined');
    }
  });

  it('treats empty search and detail arrays as valid empty results', async () => {
    const service = new OpenChargeMapService(serverConfig);
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse([]));
    await expect(
      service.searchPois({ maxresults: 1, latitude: 0, longitude: 0 }, ctx(101)),
    ).resolves.toEqual([]);

    fetchWithTimeout.mockResolvedValueOnce(jsonResponse([]));
    await expect(service.getPoi(999_999, { includeComments: true }, ctx(102))).resolves.toBeNull();
  });

  it.each([null, 'not-json-array', 42, { ID: 1 }])(
    'maps a non-array body (%j) to ServiceUnavailable',
    async (body) => {
      fetchWithTimeout.mockResolvedValue(jsonResponse(body));
      const service = new OpenChargeMapService(serverConfig);

      await expect(
        service.searchPois({ maxresults: 1, latitude: 0, longitude: 0 }, ctx(103)),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable' },
      });
    },
  );

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/15
  it.skip('maps malformed array members to ServiceUnavailable instead of leaking a TypeError', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([null, 'bad-record', 42]));
    const service = new OpenChargeMapService(serverConfig);

    await expect(
      service.searchPois({ maxresults: 3, latitude: 0, longitude: 0 }, ctx(104)),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/15
  it.skip('maps invalid JSON parsing to ServiceUnavailable instead of leaking SyntaxError', async () => {
    fetchWithTimeout.mockResolvedValue({
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as Response);
    const service = new OpenChargeMapService(serverConfig);

    await expect(
      service.searchPois({ maxresults: 1, latitude: 0, longitude: 0 }, ctx(105)),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
  });
});
