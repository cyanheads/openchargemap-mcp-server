/**
 * @fileoverview Tests for bundled and refreshed OCM reference-data resolution.
 * @module tests/services/reference-data-service.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFERENCE_SNAPSHOT_DATE } from '@/data/ocm-reference-data.js';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
  };
});

const {
  ReferenceDataService,
  getReferenceDataService,
  initReferenceDataService,
  resetReferenceDataService,
} = await import('@/services/reference-data/reference-data-service.js');
const { lookupReference } = await import('@/mcp-server/tools/definitions/lookup-reference.tool.js');
const { createMockContext } = await import('@cyanheads/mcp-ts-core/testing');
const { jsonResponse } = await import('../fixtures/ocm.js');

const bundledConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};

const liveReferenceData = {
  ConnectionTypes: [{ ID: 9001, Title: 'Live Connector', FormalName: 'LC-1' }],
  Operators: [{ ID: 9002, Title: 'Live Network' }],
  UsageTypes: [{ ID: 9003, Title: 'Live Public' }],
  StatusTypes: [{ ID: 9004, Title: 'Live Operational', IsOperational: true }],
  CurrentTypes: [{ ID: 9005, Title: 'Live Current' }],
  ChargerTypes: [{ ID: 9006, Title: 'Live Level' }],
  Countries: [{ ID: 9007, Title: 'Live Country', ISOCode: 'LC' }],
};

beforeEach(() => {
  fetchWithTimeout.mockReset();
  resetReferenceDataService();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ReferenceDataService', () => {
  it('loads the bundled snapshot without touching the network', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    expect(service.snapshotDate).toBe(REFERENCE_SNAPSHOT_DATE);
    expect(service.labelFor('connectiontypes', 33)).toBe('CCS (Type 2)');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('resolves aliases, case, surrounding whitespace, and punctuation variance', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    expect(service.resolve('connectiontypes', '  cCs  ', 10).map((match) => match.id)).toEqual([
      33, 32,
    ]);
    expect(service.resolve('connectiontypes', 'CHA-de-MO', 10)[0]).toMatchObject({
      id: 2,
      title: 'CHAdeMO',
    });
    expect(
      service.resolve('operators', '  cHaRgEpOiNt  ', 10).some((match) => match.id === 5),
    ).toBe(true);
  });

  it('returns all ambiguous connector matches in stable priority order', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    const matches = service.resolve('connectiontypes', 'Type 2', 10);
    expect(matches.slice(0, 2).map((match) => match.id)).toEqual([25, 1036]);
    expect(new Set(matches.map((match) => match.id)).size).toBe(matches.length);
  });

  it('returns no match for unknown names and stale numeric IDs', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    expect(service.resolve('operators', 'zzzz-not-a-network', 10)).toEqual([]);
    expect(service.labelFor('operators', 999_999_999)).toBeUndefined();
  });

  it('browses in numeric-ID order and reports the full category total', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    const page = service.browse('countries', 3);
    expect(page.matches).toHaveLength(3);
    expect(page.total).toBeGreaterThan(3);
    expect(page.matches.map((match) => match.id)).toEqual(
      [...page.matches.map((match) => match.id)].sort((a, b) => a - b),
    );
  });

  it('uses every category from a successful live refresh', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(liveReferenceData));
    const service = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await service.setup();

    expect(service.labelFor('connectiontypes', 9001)).toBe('Live Connector');
    expect(service.labelFor('operators', 9002)).toBe('Live Network');
    expect(service.labelFor('countries', 9007)).toBe('Live Country');
    expect(fetchWithTimeout).toHaveBeenCalledOnce();
  });

  it('falls back atomically when a live refresh omits a category', async () => {
    const { Countries: _countries, ...incomplete } = liveReferenceData;
    fetchWithTimeout.mockResolvedValue(jsonResponse(incomplete));
    const service = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await service.setup();

    expect(service.labelFor('connectiontypes', 9001)).toBeUndefined();
    expect(service.labelFor('connectiontypes', 33)).toBe('CCS (Type 2)');
    expect(service.snapshotDate).toBe(REFERENCE_SNAPSHOT_DATE);
  });

  it('falls back to the bundle when the live request fails', async () => {
    fetchWithTimeout.mockRejectedValue(new Error('offline'));
    const service = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await service.setup();

    expect(service.labelFor('operators', 5)).toBe('ChargePoint');
    expect(service.snapshotDate).toBe(REFERENCE_SNAPSHOT_DATE);
  });

  it('throws a clear accessor error before singleton initialization', () => {
    expect(getReferenceDataService).toThrow(/not initialized/i);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
  it.skip('reports the live refresh date instead of the bundled snapshot date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    fetchWithTimeout.mockResolvedValue(jsonResponse(liveReferenceData));
    const service = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await service.setup();

    expect(service.snapshotDate).toBe('2026-08-02');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
  it.skip('discloses the live source and refresh date through lookup_reference', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    fetchWithTimeout.mockResolvedValue(jsonResponse(liveReferenceData));
    await initReferenceDataService({ ...bundledConfig, referenceRefresh: true });

    const result = lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', query: 'Live Network' }),
      createMockContext({ errors: lookupReference.errors }),
    ) as { snapshotDate: string; source?: 'live' | 'bundled' };
    expect(result).toMatchObject({ source: 'live', snapshotDate: '2026-08-02' });
  });
});
