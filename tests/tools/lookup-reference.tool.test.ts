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
  it.each([
    ['missing category', {}],
    ['unknown category', { category: 'networks' }],
    ['empty query', { category: 'operators', query: '' }],
    ['zero limit', { category: 'operators', limit: 0 }],
    ['limit above maximum', { category: 'operators', limit: 101 }],
    ['fractional limit', { category: 'operators', limit: 1.5 }],
  ])('rejects %s at the Zod boundary', (_label, input) => {
    expect(() => lookupReference.input.parse(input)).toThrow();
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/13
  it.each(['   ', '\t', '\n', ' \t\n '])(
    'rejects the whitespace-only query %j instead of silently entering browse mode',
    (query) => {
      expect(() => lookupReference.input.parse({ category: 'operators', query })).toThrow();
    },
  );

  // The narrowed gate must not reach past whitespace-only: a padded real term still resolves, and
  // an omitted query is still the documented way to browse.
  it('still accepts a query padded with whitespace around real characters', () => {
    expect(
      lookupReference.input.safeParse({ category: 'operators', query: '  ChargePoint  ' }).success,
    ).toBe(true);
  });

  it('still browses when the query is omitted entirely', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', limit: 3 }),
      ctx(),
    );
    expect(result.matches).toHaveLength(3);
  });

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

  it('resolves names case-insensitively with surrounding whitespace', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', query: '  cHaRgEpOiNt  ' }),
      ctx(),
    );
    expect(result.matches.some((match) => match.id === 5)).toBe(true);
  });

  it('returns ambiguous connector matches in documented priority order', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'connectiontypes', query: 'Type 2', limit: 10 }),
      ctx(),
    );
    expect(result.matches.slice(0, 2).map((match) => match.id)).toEqual([25, 1036]);
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
    const enrichment = getEnrichment(c) as {
      truncated?: boolean;
      totalCount?: number;
      notice?: string;
    };
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.totalCount).toBeGreaterThan(5);
    // enrich.truncated() routes its guidance through `notice`, and the effective-output parse
    // strips any enrichment key the block does not declare — so the declaration is what keeps the
    // "raise limit / pass a query" path on the wire, not the write.
    expect(enrichment.notice).toMatch(/raise limit/i);
    expect(lookupReference.enrichment).toHaveProperty('notice');
  });

  it('surfaces statustypes operational detail and snapshotDate', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'statustypes', query: 'Operational' }),
      ctx(),
    );
    expect(result.matches.some((m) => m.detail?.includes('operational'))).toBe(true);
    expect(result.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toEqual(expect.schemaMatching(lookupReference.output));
  });

  it.each([
    ['connectiontypes', 'connectiontypeid'],
    ['operators', 'operatorid'],
    ['usagetypes', 'usagetypeid'],
    ['statustypes', 'statustypeid'],
    ['levels', 'levelid'],
    ['currenttypes', undefined],
    ['countries', undefined],
  ] as const)('maps %s to its find_stations filter parameter', async (category, expected) => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category, limit: 1 }),
      ctx(),
    );
    expect(result.filterParam).toBe(expected);
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

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/12
  it('does not write unreachable enrichment immediately before no_match', () => {
    const c = ctx();
    expect(() =>
      lookupReference.handler(
        lookupReference.input.parse({ category: 'operators', query: 'zzzznotanetwork' }),
        c,
      ),
    ).toThrow();
    expect(getEnrichment(c)).not.toHaveProperty('notice');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('does not describe Temporarily Unavailable as operational', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'statustypes', query: 'Temporarily Unavailable' }),
      ctx(),
    );
    expect(result.matches[0]?.detail).not.toContain('counts as operational');
    expect(result.matches[0]?.detail).toContain('unavailable');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('describes Partly Operational (Mixed) as only partly working', async () => {
    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'statustypes', query: 'Partly Operational' }),
      ctx(),
    );
    expect(result.matches[0]?.id).toBe(75);
    expect(result.matches[0]?.detail).toContain('only part of the site works');
  });
});
