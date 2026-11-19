/**
 * @fileoverview Tests for bundled and refreshed OCM reference-data resolution.
 * @module tests/services/reference-data-service.test
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFERENCE_SNAPSHOT, REFERENCE_SNAPSHOT_DATE } from '@/data/ocm-reference-data.js';
import type { ReferenceCategory } from '@/services/reference-data/types.js';

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
    expect(service.source).toBe('bundled');
    expect(service.labelFor('connectiontypes', 33)).toBe('CCS (Type 2)');
    expect(service.hasCountryCode('Us')).toBe(true);
    expect(service.hasCountryCode('zz')).toBe(false);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('resolves aliases, case, surrounding whitespace, and punctuation variance', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    expect(
      service.resolve('connectiontypes', '  cCs  ', 10).matches.map((match) => match.id),
    ).toEqual([33, 32]);
    expect(service.resolve('connectiontypes', 'CHA-de-MO', 10).matches[0]).toMatchObject({
      id: 2,
      title: 'CHAdeMO',
    });
    expect(
      service.resolve('operators', '  cHaRgEpOiNt  ', 10).matches.some((match) => match.id === 5),
    ).toBe(true);
  });

  it('returns all ambiguous connector matches in stable priority order', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    const { matches } = service.resolve('connectiontypes', 'Type 2', 10);
    expect(matches.slice(0, 2).map((match) => match.id)).toEqual([25, 1036]);
    expect(new Set(matches.map((match) => match.id)).size).toBe(matches.length);
  });

  it('returns no match for unknown names and stale numeric IDs', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    expect(service.resolve('operators', 'zzzz-not-a-network', 10)).toEqual({
      matches: [],
      total: 0,
    });
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

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('walks a whole category through consecutive browse offsets without gaps or repeats', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    const { total } = service.browse('countries', 1);
    const seen: number[] = [];
    for (let offset = 0; offset < total; offset += 40) {
      seen.push(...service.browse('countries', 40, offset).matches.map((match) => match.id));
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(service.browse('countries', 40, total).matches).toEqual([]);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/5
  it('reports every query match as the total and pages the remainder by offset', async () => {
    const service = new ReferenceDataService(bundledConfig);
    await service.setup();

    const all = service.resolve('connectiontypes', 'Type', 100);
    expect(all.total).toBeGreaterThan(2);

    const firstTwo = service.resolve('connectiontypes', 'Type', 2);
    const nextTwo = service.resolve('connectiontypes', 'Type', 2, 2);

    expect(firstTwo.total).toBe(all.total); // total is the match count, not the page size
    expect(firstTwo.matches.map((match) => match.id)).toEqual(
      all.matches.slice(0, 2).map((match) => match.id),
    );
    expect(nextTwo.matches.map((match) => match.id)).toEqual(
      all.matches.slice(2, 4).map((match) => match.id),
    );
  });

  it('uses every category from a successful live refresh', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(liveReferenceData));
    const service = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await service.setup();

    expect(service.labelFor('connectiontypes', 9001)).toBe('Live Connector');
    expect(service.labelFor('operators', 9002)).toBe('Live Network');
    expect(service.labelFor('countries', 9007)).toBe('Live Country');
    expect(service.hasCountryCode('lc')).toBe(true);
    expect(service.hasCountryCode('US')).toBe(false);
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
    // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
    expect(service.source).toBe('bundled');
  });

  it('falls back to the bundle when the live request fails', async () => {
    fetchWithTimeout.mockRejectedValue(new Error('offline'));
    const service = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await service.setup();

    expect(service.labelFor('operators', 5)).toBe('ChargePoint');
    expect(service.snapshotDate).toBe(REFERENCE_SNAPSHOT_DATE);
    // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
    // A failed refresh serves the bundle, so it reports the bundle — the date does not drift
    // forward to the day the failed attempt was made.
    expect(service.source).toBe('bundled');
  });

  it('throws a clear accessor error before singleton initialization', () => {
    expect(getReferenceDataService).toThrow(/not initialized/i);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
  it('reports the live refresh date instead of the bundled snapshot date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    fetchWithTimeout.mockResolvedValue(jsonResponse(liveReferenceData));
    const service = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await service.setup();

    expect(service.snapshotDate).toBe('2026-08-02');
    // The live set is what is indexed, so the reported vintage has to move with it.
    expect(service.labelFor('operators', 9002)).toBe('Live Network');
    expect(service.source).toBe('live');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
  it('discloses the live source and refresh date through lookup_reference', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    fetchWithTimeout.mockResolvedValue(jsonResponse(liveReferenceData));
    await initReferenceDataService({ ...bundledConfig, referenceRefresh: true });

    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', query: 'Live Network' }),
      createMockContext({ errors: lookupReference.errors }),
    );
    expect(result).toMatchObject({ source: 'live', snapshotDate: '2026-08-02' });
    expect(result).toEqual(expect.schemaMatching(lookupReference.output));
    // Both facts reach content[]-only clients too, not just structuredContent.
    const text = (lookupReference.format!(result)[0] as { text: string }).text;
    expect(text).toContain('live');
    expect(text).toContain('2026-08-02');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/11
  it('reports the bundled vintage through lookup_reference when the refresh is off', async () => {
    await initReferenceDataService(bundledConfig);

    const result = await lookupReference.handler(
      lookupReference.input.parse({ category: 'operators', query: 'ChargePoint' }),
      createMockContext({ errors: lookupReference.errors }),
    );
    expect(result).toMatchObject({ source: 'bundled', snapshotDate: REFERENCE_SNAPSHOT_DATE });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

// https://github.com/cyanheads/openchargemap-mcp-server/issues/36
describe('ReferenceDataService word-start matching', () => {
  let service: InstanceType<typeof ReferenceDataService>;

  beforeAll(async () => {
    service = new ReferenceDataService(bundledConfig);
    await service.setup();
  });

  const ids = (category: ReferenceCategory, query: string) =>
    service.resolve(category, query, 10_000).matches.map((match) => match.id);

  it.each([
    ['connectiontypes', 'J-1772', [1]],
    ['connectiontypes', 'SAE 1772', [1]],
    ['connectiontypes', '1772', [1]],
    ['connectiontypes', 'BS 1363', [3]],
    ['connectiontypes', 'Euro plug', [13]],
    ['levels', '2 kW', [1, 2]],
    ['operators', 'Charge Point', [5]],
    ['operators', 'point', [5]],
    ['operators', 'EV Power', [3643]],
    ['operators', 'Swiss charge', [3273]],
    ['countries', 'The Netherlands', [159]],
    ['countries', 'Korea', [120, 121]],
  ] as const)('keeps resolving %s %j to %j', (category, query, expected) => {
    expect(ids(category, query)).toEqual(expect.arrayContaining([...expected]));
  });

  it.each([
    ['countries', 'US', [18, 19, 25, 32, 38, 63, 144, 185], [2]],
    ['countries', 'oman', [184], [169]],
    ['statustypes', 'available', [30], [10]],
    ['operators', 'charge', [3273, 47, 59, 3832], [5, 20, 41]],
  ] as const)(
    'stops matching %s %j inside a word (drops %j, keeps %j)',
    (category, query, dropped, kept) => {
      const got = ids(category, query);
      for (const id of dropped) expect(got).not.toContain(id);
      expect(got).toEqual(expect.arrayContaining([...kept]));
    },
  );

  it.each([
    // Reported misses and misrankings.
    ['countries', 'UK', [1]],
    ['countries', 'US', [2]],
    ['levels', 'level 2', [2]],
    ['countries', 'USA', [2]],
    ['countries', 'Holland', [159]],
    ['countries', 'South Korea', [121]],
    ['connectiontypes', 'CCS1', [32]],
    ['connectiontypes', 'CCS2', [33]],
    ['connectiontypes', 'type2', [25, 1036]],
    ['levels', 'fast', [3]],
    ['levels', 'DC fast', [3]],
    // Remaining curated aliases, in listed order.
    ['countries', 'Great Britain', [1]],
    ['countries', 'Britain', [1]],
    ['countries', 'England', [1]],
    ['countries', 'Scotland', [1]],
    ['countries', 'Wales', [1]],
    ['countries', 'Northern Ireland', [1]],
    ['countries', 'United States of America', [2]],
    ['countries', 'North Korea', [120]],
    ['levels', 'DCFC', [3]],
    ['connectiontypes', 'Combo 1', [32]],
    ['connectiontypes', 'CCS Combo 1', [32]],
    ['connectiontypes', 'Combo 2', [33]],
    ['connectiontypes', 'CCS Combo 2', [33]],
    ['connectiontypes', 'Tesla', [27, 8, 30, 31]],
    // Separator-insensitive exact, alias, and prefix paths.
    ['countries', 'U.K.', [1]],
    ['countries', 'Vietnam', [241]],
    ['connectiontypes', 'type1', [1]],
    ['connectiontypes', 'GBT', [1038, 1039, 1040]],
    ['levels', 'Level3', [3]],
    // A leading "the" is optional.
    ['countries', 'the UK', [1]],
    ['countries', 'The Netherlands', [159]],
  ] as const)('ranks %s %j as %j first', (category, query, expected) => {
    expect(ids(category, query).slice(0, expected.length)).toEqual(expected);
  });

  it('lists whole-word "charge" operators after the exact title and before word-prefix hits', () => {
    const got = ids('operators', 'charge');
    expect(got[0]).toBe(3926); // CHARGE+ is the exact title once punctuation is ignored
    expect(got.indexOf(20)).toBeGreaterThan(0); // Charge Your Car
    expect(got.indexOf(41)).toBeGreaterThan(0); // MAGNE Charge
    expect(got.indexOf(5)).toBeGreaterThan(got.indexOf(20)); // ChargePoint, a word prefix
    expect(got.indexOf(5)).toBeGreaterThan(got.indexOf(41));
  });

  it('breaks rank ties by ascending ID, the order paging relies on', () => {
    expect(ids('countries', 'Korea')).toEqual([120, 121]);
    const all = ids('operators', 'shell recharge');
    expect(all.length).toBeGreaterThan(2);
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });

  it('ranks a word-start digit inside a word below a whole word ("2" in "2kW")', () => {
    expect(ids('levels', 'level 2')).toEqual([2, 1]);
  });

  /**
   * Every substring that starts at a sub-word boundary inside a title or formal-name word (a
   * CamelCase, acronym→word, or letter–digit transition) and is not already a prefix of a whole
   * word. Plain word-start matching would drop each of these; the boundary rule must keep them.
   * Derived from the snapshot with its own boundary regex, independent of the service code.
   */
  it('keeps every snapshot spelling that starts at a CamelCase, acronym, or letter–digit boundary', () => {
    const boundary =
      /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;
    const wordsOf = (text: string) =>
      text
        .normalize('NFKD')
        .replace(/[\u{300}-\u{36f}]/gu, '')
        .split(/[^\p{L}\p{M}\p{N}]+/u)
        .filter(Boolean);

    const corpus: { category: ReferenceCategory; query: string; id: number }[] = [];
    for (const [category, entries] of Object.entries(REFERENCE_SNAPSHOT) as [
      ReferenceCategory,
      (typeof REFERENCE_SNAPSHOT)[ReferenceCategory],
    ][]) {
      for (const entry of entries) {
        const fields = [entry.Title, entry.FormalName].filter((f): f is string => !!f);
        const words = fields.flatMap(wordsOf);
        const lowerWords = words.map((word) => word.toLowerCase());
        const queries = new Set<string>();
        for (const word of words) {
          const lowerWord = word.toLowerCase();
          let at = 0;
          for (const part of word.split(boundary).slice(0, -1)) {
            at += part.length;
            for (let end = at + 2; end <= lowerWord.length; end++) {
              const query = lowerWord.slice(at, end);
              if (!lowerWords.some((w) => w.startsWith(query))) queries.add(query);
            }
          }
        }
        for (const query of queries) corpus.push({ category, query, id: entry.ID });
      }
    }

    // Anchors from each boundary class, so an empty derivation cannot pass vacuously.
    for (const anchor of [
      { category: 'operators', query: 'point', id: 5 }, // Charge·Point
      { category: 'operators', query: 'power', id: 3643 }, // EV·Power
      { category: 'connectiontypes', query: '1772', id: 1 }, // J·1772
      { category: 'levels', query: 'kw', id: 1 }, // 2·kW
    ])
      expect(corpus).toContainEqual(anchor);
    expect(corpus.length).toBeGreaterThanOrEqual(779);

    const missed = corpus.filter(({ category, query, id }) => !ids(category, query).includes(id));
    expect(missed).toEqual([]);
  });
});

// https://github.com/cyanheads/openchargemap-mcp-server/issues/36
describe('ReferenceDataService non-Latin titles', () => {
  let service: InstanceType<typeof ReferenceDataService>;

  beforeAll(async () => {
    service = new ReferenceDataService(bundledConfig);
    await service.setup();
  });

  const ids = (query: string) =>
    service.resolve('operators', query, 10_000).matches.map((match) => match.id);

  it.each([
    ['МГТС', 3487],
    ['мгтс', 3487],
    ['Энергия Москвы', 3653],
    ['ЭЗС СК', 3699],
    ['Яндекс', 3682],
    ['Заправки', 3682],
    ['РусГидро', 3592],
    ['Гидро', 3592], // Cyrillic CamelCase: Рус·Гидро
    ['Энтерпрайз', 3362], // Авто·Энтерпрайз
    ['تسلا', 3980],
  ] as const)('resolves %j to operator %i first', (query, id) => {
    expect(ids(query)[0]).toBe(id);
  });

  // Letters with no Unicode decomposition fold to their unaccented base, like diacritics do.
  it.each([
    ['Gronn', 3247], // Grønn Kontakt
    ['gronn kontakt', 3247],
    ['Yakit', 3601], // En Yakıt (TR)
    ['Vestfjarda', 3708], // Orkubú Vestfjarða
  ] as const)('resolves %j to operator %i first', (query, id) => {
    expect(ids(query)[0]).toBe(id);
  });

  it('starts no sub-word inside a caseless or single-case run', () => {
    expect(ids('سلا')).not.toContain(3980); // inside تسلا (Arabic script has no case)
    expect(ids('идро')).not.toContain(3592); // inside Гидро, lowercase throughout
  });

  it('folds Greek case and final sigma so a query prefixes longer words', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse({
        ...liveReferenceData,
        Operators: [{ ID: 9101, Title: 'ΟΔΟΣΤΡΩΤΗΡΑΣ Φόρτιση' }],
      }),
    );
    const live = new ReferenceDataService({ ...bundledConfig, referenceRefresh: true });
    await live.setup();
    const liveIds = (query: string) =>
      live.resolve('operators', query, 10).matches.map((match) => match.id);

    expect(liveIds('ΟΔΟΣ')).toEqual([9101]); // ends in Σ, which lowercases to final ς
    expect(liveIds('οδοστρωτηρασ')).toEqual([9101]);
    expect(liveIds('φορτιση')).toEqual([9101]); // accent folded like Latin diacritics
  });
});

// https://github.com/cyanheads/openchargemap-mcp-server/issues/36
describe('ReferenceDataService query cost (linear time)', () => {
  let service: InstanceType<typeof ReferenceDataService>;

  beforeAll(async () => {
    service = new ReferenceDataService(bundledConfig);
    await service.setup();
  });

  /** This thread's CPU time in µs. Wall clock would count every moment a busy machine deschedules it. */
  const cpuMicros = () => {
    const { user, system } = process.threadCpuUsage();
    return user + system;
  };

  /** Least per-call CPU time (µs) over several batches — a garbage-collection pause only adds time. */
  const leastPerCall = (category: ReferenceCategory, query: string, calls: number) => {
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = cpuMicros();
      for (let call = 0; call < calls; call++) service.resolve(category, query, 25);
      least = Math.min(least, (cpuMicros() - start) / calls);
    }
    return least;
  };

  /** Join generated words with spaces until the text reaches `size` characters. */
  const words = (size: number, word: (i: number) => string) => {
    const parts: string[] = [];
    for (let i = 0, length = 0; length < size; i++) {
      parts.push(word(i));
      length += parts.at(-1)!.length + 1;
    }
    return parts.join(' ').slice(0, size);
  };

  const shapes: [string, (size: number) => string][] = [
    ['distinct words', (size) => words(size, (i) => i.toString(36))],
    ['one word repeated', (size) => words(size, () => 'charge')],
    ['leading "the" repeated', (size) => words(size, () => 'the')],
    ['one long word', (size) => 'a'.repeat(size)],
    ['digit run', (size) => '1'.repeat(size)],
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size) => `${'  \r\n'.repeat(size / 4)}x`],
    ['combining marks', (size) => 'e\u{301}'.repeat(size / 2)],
    ['cased Cyrillic word', (size) => 'РусГидро'.repeat(size / 8)],
  ];

  it.each(shapes)(
    'resolves a %s query in time linear in its length',
    (_shape, make) => {
      const baseline = make(5_000);
      // Doubling, with the bound checked at each size before the next runs, so super-linear
      // growth fails at a mid-size instead of stalling on the largest input.
      for (let size = 10_000; size <= 320_000; size *= 2) {
        const query = make(size);
        const growths: number[] = [];
        let perCall = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 3; pair++) {
          // The baseline is re-timed beside each size, so a core switch between the two cannot
          // read as growth.
          const base = leastPerCall('operators', baseline, 8);
          const sized = leastPerCall('operators', query, 1);
          growths.push(sized / base);
          perCall = Math.min(perCall, sized);
        }
        expect(Math.min(...growths), `growth from 5k to ${size} characters`).toBeLessThan(256);
        expect(perCall, `CPU µs per call at ${size} characters`).toBeLessThan(size / 2);
      }
    },
    0,
  );

  it('keeps a long query costing about the same in a large category as in a small one', () => {
    const query = words(320_000, () => 'charge');
    const ratios: number[] = [];
    for (let pair = 0; pair < 3; pair++)
      ratios.push(leastPerCall('operators', query, 1) / leastPerCall('levels', query, 1));
    expect(Math.min(...ratios)).toBeLessThan(4);
  }, 0);
});
