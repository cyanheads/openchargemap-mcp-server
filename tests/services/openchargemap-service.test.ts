/**
 * @fileoverview Tests for OpenChargeMapService at the service boundary — focused on the cache-key
 * contract. The framework's StorageService rejects any key outside `/^[a-zA-Z0-9_.\-/]+$/` (colons,
 * `?`, `=`, `&` are invalid), but the in-memory storage backing `createMockContext` does NOT enforce
 * that rule — so a malformed cache key sails through handler tests and only throws against real
 * (HTTP/persistent) storage at runtime. These tests capture the exact keys the service passes to
 * `ctx.state` and assert they are storage-safe, catching that class of bug the mock cannot.
 * @module tests/services/openchargemap-service.test
 */

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

const { OpenChargeMapService } = await import('@/services/openchargemap/openchargemap-service.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { FULL_POI, FULL_POI_DETAIL, jsonResponse } = await import('../fixtures/ocm.js');

/** The framework's storage-key validator (`storageValidation.ts`): only these characters are legal. */
const VALID_KEY_PATTERN = /^[a-zA-Z0-9_.\-/]+$/;

const serverConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};

beforeEach(async () => {
  fetchWithTimeout.mockReset();
  await initReferenceDataService(serverConfig);
});

afterEach(() => vi.clearAllMocks());

/** A mock context whose `state.get`/`state.set` calls are spied so we can inspect the keys used. */
function spiedCtx() {
  const ctx = createMockContext({ tenantId: 'test' });
  const getSpy = vi.spyOn(ctx.state, 'get');
  const setSpy = vi.spyOn(ctx.state, 'set');
  return { ctx, getSpy, setSpy };
}

describe('OpenChargeMapService cache keys are storage-safe', () => {
  it('searchPois uses a key the framework storage validator accepts (no colons)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx, getSpy, setSpy } = spiedCtx();

    await svc.searchPois({ maxresults: 10, latitude: 47.6, longitude: -122.3, distance: 5 }, ctx);

    const getKey = getSpy.mock.calls[0]![0] as string;
    const setKey = setSpy.mock.calls[0]![0] as string;
    expect(getKey).toMatch(VALID_KEY_PATTERN);
    expect(setKey).toMatch(VALID_KEY_PATTERN);
    expect(getKey).toBe(setKey); // read and write address the same cache slot
    expect(getKey).not.toContain(':');
  });

  it('getPoi uses a key the framework storage validator accepts (no colons)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx, getSpy, setSpy } = spiedCtx();

    await svc.getPoi(145452, { includeComments: true }, ctx);

    const getKey = getSpy.mock.calls[0]![0] as string;
    const setKey = setSpy.mock.calls[0]![0] as string;
    expect(getKey).toMatch(VALID_KEY_PATTERN);
    expect(setKey).toMatch(VALID_KEY_PATTERN);
    expect(getKey).toBe(setKey);
    expect(getKey).not.toContain(':');
  });

  it('distinct search params produce distinct cache keys', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI]));
    const svc = new OpenChargeMapService(serverConfig);

    const { ctx: c1, setSpy: s1 } = spiedCtx();
    await svc.searchPois({ maxresults: 10, latitude: 47.6, longitude: -122.3, distance: 5 }, c1);
    const { ctx: c2, setSpy: s2 } = spiedCtx();
    await svc.searchPois({ maxresults: 10, latitude: 51.5, longitude: -0.12, distance: 5 }, c2);

    expect(s1.mock.calls[0]![0]).not.toBe(s2.mock.calls[0]![0]);
  });

  it('caches the empty-result sentinel and returns null without a second fetch', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const svc = new OpenChargeMapService(serverConfig);
    const { ctx } = spiedCtx();

    const first = await svc.getPoi(99999991, { includeComments: false }, ctx);
    const second = await svc.getPoi(99999991, { includeComments: false }, ctx);

    expect(first).toBeNull();
    expect(second).toBeNull();
    // Second call served from the cached 'EMPTY' sentinel — only one upstream fetch.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});
