/**
 * @fileoverview Tests for openchargemap_lookup_reference — offline resolution from the bundled
 * snapshot: alias resolution (the headline goal), exact + token matching, browse + truncation, the
 * filterParam mapping, and the no_match contract error. No network.
 * @module tests/tools/lookup-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { lookupReference } from '@/mcp-server/tools/definitions/lookup-reference.tool.js';
import { initReferenceDataService } from '@/services/reference-data/reference-data-service.js';

const serverConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};

beforeEach(async () => {
  await initReferenceDataService(serverConfig);
});

const ctx = () => createMockContext({ tenantId: 'test', errors: lookupReference.errors });

describe('openchargemap_lookup_reference', () => {
  it('resolves "CCS" to connectiontypeid 33 (CCS Type 2) first (headline goal)', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'connectiontypes', query: 'CCS' }),
      ctx(),
    );
    expect(result.matches[0]!.id).toBe(33);
    expect(result.matches[0]!.title).toBe('CCS (Type 2)');
    expect(result.matches.map((m) => m.id)).toContain(32);
    expect(result.filterParam).toBe('connectiontypeid');
  });

  it('resolves "Tesla Supercharger" and "NACS" to id 27 via curated aliases', async () => {
    for (const query of ['Tesla Supercharger', 'NACS']) {
      const result = await lookupReference.handler(
        lookupReference.input.parse({ category: 'connectiontypes', query }),
        ctx(),
      );
      expect(result.matches[0]!.id).toBe(27);
    }
  });

  it('resolves an operator name (ChargePoint) to an operatorid', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', query: 'ChargePoint' }),
      ctx(),
    );
    expect(result.matches.some((m) => m.title === 'ChargePoint')).toBe(true);
    expect(result.filterParam).toBe('operatorid');
  });

  it('resolves a country by name and by ISO code', async () => {
    const byName = await lookupReference.handler(
      lookupReference.input.parse({ category: 'countries', query: 'United States' }),
      ctx(),
    );
    expect(byName.matches[0]!.isoCode).toBe('US');
    const byCode = await lookupReference.handler(
      lookupReference.input.parse({ category: 'countries', query: 'FR' }),
      ctx(),
    );
    expect(byCode.matches[0]!.title).toBe('France');
    // Countries have no direct find_stations filter param (use countrycode).
    expect(byCode.filterParam).toBeUndefined();
  });

  it('browses a full category and discloses truncation when capped', async () => {
    const c = ctx();
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', limit: 5 }),
      c,
    );
    expect(result.matches).toHaveLength(5);
    const enrichment = getEnrichment(c) as { truncated?: boolean; totalCount?: number };
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.totalCount).toBeGreaterThan(5);
  });

  it('surfaces statustypes operational detail and snapshotDate', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'statustypes', query: 'Operational' }),
      ctx(),
    );
    expect(result.matches.some((m) => m.detail?.includes('operational'))).toBe(true);
    expect(result.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('throws no_match for an unresolvable query', () => {
    // Handler is synchronous, so it throws rather than rejecting.
    const call = () =>
      lookupReference.handler(
        lookupReference.input.parse({ category: 'connectiontypes', query: 'zzzznotaconnector' }),
        ctx(),
      );
    expect(call).toThrow();
    try {
      call();
    } catch (err) {
      expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'no_match' } });
    }
  });

  it('format() renders ids, titles, and the filter-param guidance', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'connectiontypes', query: 'CHAdeMO' }),
      ctx(),
    );
    const text = (lookupReference.format!(result)[0] as { text: string }).text;
    expect(text).toContain('CHAdeMO');
    expect(text).toContain('connectiontypeid');
    expect(text).toContain('CC BY 4.0');
  });
});
