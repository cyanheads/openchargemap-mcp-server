/**
 * @fileoverview Reference-data service — resolves Open Charge Map reference names/codes to the
 * integer IDs that POI filters key on, served from a bundled snapshot (offline, zero-latency).
 * Builds per-category lookup indices (ID, word starts, separator-free exact keys, curated aliases)
 * at init, with an optional startup refresh from the live `/v3/referencedata` endpoint that falls
 * back to the bundled snapshot on any failure.
 * @module services/reference-data/reference-data-service
 */

import {
  fetchWithTimeout,
  logger,
  requestContextService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import {
  REFERENCE_SNAPSHOT,
  REFERENCE_SNAPSHOT_DATE,
  type ReferenceEntry,
} from '@/data/ocm-reference-data.js';
import { statusAvailability } from '@/services/openchargemap/attribution.js';
import type { ReferenceCategory, ReferenceMatch, ReferencePage, ReferenceSource } from './types.js';

/** The `find_stations` input parameter each category's IDs feed (omitted where there's no direct filter). */
const FILTER_PARAM: Partial<Record<ReferenceCategory, string>> = {
  connectiontypes: 'connectiontypeid',
  operators: 'operatorid',
  usagetypes: 'usagetypeid',
  statustypes: 'statustypeid',
  levels: 'levelid',
};

/**
 * Latin letters Unicode gives no decomposition, folded to their unaccented base so "Gronn" meets
 * "Grønn". Capitals map to a capital then lowercase, so no CamelCase start appears inside them.
 */
const LATIN_BASE = new Map([
  ['ø', 'o'],
  ['Ø', 'O'],
  ['ı', 'i'],
  ['ł', 'l'],
  ['Ł', 'L'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['ħ', 'h'],
  ['Ħ', 'H'],
  ['ŧ', 't'],
  ['Ŧ', 'T'],
  ['æ', 'ae'],
  ['Æ', 'Ae'],
  ['œ', 'oe'],
  ['Œ', 'Oe'],
  ['ß', 'ss'],
  ['þ', 'th'],
  ['Þ', 'Th'],
]);
const LATIN_BASE_PATTERN = new RegExp(`[${[...LATIN_BASE.keys()].join('')}]`, 'gu');

/**
 * Fold text for matching: compatibility-decompose, drop the combining diacritics of Latin, Greek,
 * and Cyrillic (U+0300–U+036F) so "Rhône" and "Rhone" meet, then map {@link LATIN_BASE}. Other
 * combining marks stay — scripts that write vowels as marks (Devanagari, Thai) would otherwise
 * split mid-word.
 */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u{300}-\u{36f}]/gu, '')
    .replace(LATIN_BASE_PATTERN, (letter) => LATIN_BASE.get(letter) ?? letter);
}

/** Whitespace and punctuation: everything that is not a letter, combining mark, or number. */
const SEPARATORS = /[^\p{L}\p{M}\p{N}]+/u;

/** Folded, original-case words of `text`, delimited by whitespace and punctuation. */
function casedWords(text: string): string[] {
  return fold(text).split(SEPARATORS).filter(Boolean);
}

/**
 * Case-insensitive form of a folded word. Greek final sigma becomes σ, so a query ending in Σ
 * (lowercased to ς) still prefixes a longer word. After {@link fold} no code point changes UTF-16
 * length under `toLowerCase`, so offsets found in the cased word index the lowered one.
 */
function lower(word: string): string {
  return word.toLowerCase().replaceAll('ς', 'σ');
}

/** Lowercase query words, in order. Empty when the text has no letter or number. */
function queryWords(text: string): string[] {
  return casedWords(text).map(lower);
}

/** Separator-free lowercase form — the key for exact and alias comparisons. */
function compactKey(text: string): string {
  return queryWords(text).join('');
}

type CharKind = 'upper' | 'lower' | 'caseless' | 'number' | 'mark';

function charKind(char: string): CharKind {
  if (/\p{Lu}/u.test(char)) return 'upper';
  if (/\p{Ll}/u.test(char)) return 'lower';
  if (/\p{L}/u.test(char)) return 'caseless';
  if (/\p{N}/u.test(char)) return 'number';
  return 'mark';
}

/**
 * UTF-16 offsets inside an original-case word where a sub-word starts: lowercase→uppercase
 * (Charge·Point), acronym→word (EV·Power), and letter↔number (J·1772, 2·kW). Combining marks are
 * skipped when comparing neighbours. Caseless letters (Arabic, CJK, Devanagari) never start a
 * case transition, so a run in a script without case stays one sub-word.
 */
function subWordStarts(word: string): number[] {
  const chars: { at: number; kind: CharKind }[] = [];
  let at = 0;
  for (const char of word) {
    const kind = charKind(char);
    if (kind !== 'mark') chars.push({ at, kind });
    at += char.length;
  }
  const starts: number[] = [];
  chars.forEach(({ at, kind }, i) => {
    const prev = chars[i - 1]?.kind;
    const next = chars[i + 1]?.kind;
    if (
      prev !== undefined &&
      ((prev === 'number') !== (kind === 'number') ||
        (prev === 'lower' && kind === 'upper') ||
        (prev === 'upper' && kind === 'upper' && next === 'lower'))
    )
      starts.push(at);
  });
  return starts;
}

/** Build an alias map keyed by the separator-free form of each readable key. */
function aliasMap<T>(entries: [string, T[]][]): Map<string, T[]> {
  return new Map(entries.map(([key, targets]) => [compactKey(key), targets]));
}

/*
 * Curated aliases → targets in priority order; the first target listed ranks first. Keys compare
 * separator-free ("type2", "U.K.", "CHA-de-MO" reach their keys). Each is a `Map`, so prototype
 * names such as `constructor` fall through to ordinary matching.
 */

/** Connector names agents actually use → connection-type IDs. */
const CONNECTOR_ALIASES = aliasMap<number>([
  ['j1772', [1]],
  ['type 1', [1]],
  ['ccs', [33, 32]],
  ['ccs1', [32]],
  ['ccs type 1', [32]],
  ['combo 1', [32]],
  ['ccs combo 1', [32]],
  ['ccs2', [33]],
  ['ccs type 2', [33]],
  ['combo 2', [33]],
  ['ccs combo 2', [33]],
  ['ccs combo', [33, 32]],
  ['combo', [33, 32]],
  ['tesla', [27]], // the current connector, ahead of the discontinued Roadster (8)
  ['supercharger', [27]],
  ['tesla supercharger', [27]],
  ['nacs', [27]],
  ['tesla nacs', [27]],
  ['type 2', [25, 1036]],
  ['mennekes', [25, 1036]],
  ['chademo', [2]],
  ['chaoji', [1044]],
]);

/** Charge-level names → level IDs. Level 3 is the only fast-charge-capable level. */
const LEVEL_ALIASES = aliasMap<number>([
  ['fast', [3]],
  ['dc fast', [3]],
  ['dcfc', [3]],
]);

/** Common country names OCM titles differently → ISO codes, resolved against the active data. */
const COUNTRY_ALIASES = aliasMap<string>([
  ['uk', ['GB']],
  ['great britain', ['GB']],
  ['britain', ['GB']],
  ['england', ['GB']],
  ['scotland', ['GB']],
  ['wales', ['GB']],
  ['northern ireland', ['GB']],
  ['usa', ['US']],
  ['united states of america', ['US']],
  ['holland', ['NL']],
  ['south korea', ['KR']],
  ['north korea', ['KP']],
]);

/** Rank tiers, best first. Alias hits rank by their position in the alias list, below `EXACT`. */
const RANK_EXACT = 1000;
const RANK_WHOLE_WORDS = 2000;
const RANK_WORD_START = 3000;

/** OCM categories the live `/referencedata` response carries, mapped to this server's slugs. */
const LIVE_CATEGORY_KEYS: Record<ReferenceCategory, string> = {
  connectiontypes: 'ConnectionTypes',
  operators: 'Operators',
  usagetypes: 'UsageTypes',
  statustypes: 'StatusTypes',
  currenttypes: 'CurrentTypes',
  levels: 'ChargerTypes',
  countries: 'Countries',
};

/** Word-start index for one entry's title and formal name. */
interface EntryWords {
  /** Lowercase separator-free text from each word start to the end of its field. */
  compactStarts: string[];
  entry: ReferenceEntry;
  /** Lowercase text from each word start (delimited or sub-word) to the end of its word. */
  starts: string[];
  /** Lowercase whitespace/punctuation-delimited words. */
  words: Set<string>;
}

function indexWords(entry: ReferenceEntry): EntryWords {
  const words = new Set<string>();
  const starts: string[] = [];
  const compactStarts: string[] = [];
  for (const field of [entry.Title, entry.FormalName]) {
    if (!field) continue;
    const pairs = casedWords(field).map((word) => ({ word, lowerWord: lower(word) }));
    const compact = pairs.map(({ lowerWord }) => lowerWord).join('');
    let fieldOffset = 0;
    for (const { word, lowerWord } of pairs) {
      words.add(lowerWord);
      for (const at of [0, ...subWordStarts(word)]) {
        starts.push(lowerWord.slice(at));
        compactStarts.push(compact.slice(fieldOffset + at));
      }
      fieldOffset += lowerWord.length;
    }
  }
  return { entry, words, starts, compactStarts };
}

/** Per-category index: ordered entries, ID lookup, word starts, exact keys, aliases. */
interface CategoryIndex {
  /** Separator-free alias → entries in priority order. */
  aliases: Map<string, ReferenceEntry[]>;
  byId: Map<number, ReferenceEntry>;
  entries: ReferenceEntry[];
  /** Separator-free title, formal name, and ISO code → entries. */
  exact: Map<string, ReferenceEntry[]>;
  /** Word-start index per entry, ascending ID. */
  words: EntryWords[];
}

/** Categories whose aliases name reference IDs directly. */
const ID_ALIASES: Partial<Record<ReferenceCategory, Map<string, number[]>>> = {
  connectiontypes: CONNECTOR_ALIASES,
  levels: LEVEL_ALIASES,
};

/**
 * A category's curated aliases resolved against the active data: IDs (or, for countries, ISO
 * codes) the active data does not carry drop out.
 */
function aliasTargets(
  category: ReferenceCategory,
  entries: ReferenceEntry[],
  byId: Map<number, ReferenceEntry>,
): Map<string, ReferenceEntry[]> {
  if (category === 'countries') {
    const byIso = new Map(
      entries.flatMap((entry) => (entry.ISOCode ? [[entry.ISOCode.toUpperCase(), entry]] : [])),
    );
    return new Map(
      [...COUNTRY_ALIASES].map(([key, codes]) => [
        key,
        codes.flatMap((code) => byIso.get(code) ?? []),
      ]),
    );
  }
  return new Map(
    [...(ID_ALIASES[category] ?? [])].map(([key, ids]) => [
      key,
      ids.flatMap((id) => byId.get(id) ?? []),
    ]),
  );
}

/**
 * Rank every entry one query's words match (lower is better). Tiers: curated alias (in listed
 * order), exact title / formal name / ISO code, every word a whole word of the entry, then any
 * other match — every word a prefix of the entry's text at some word start, in any order, or the
 * separator-free query a prefix of the separator-free text from a word start.
 */
function rankMatches(index: CategoryIndex, words: string[]): Map<ReferenceEntry, number> {
  const ranks = new Map<ReferenceEntry, number>();
  const key = words.join('');
  index.aliases.get(key)?.forEach((entry, i) => void ranks.set(entry, i));
  for (const entry of index.exact.get(key) ?? [])
    if (!ranks.has(entry)) ranks.set(entry, RANK_EXACT);

  // A repeated word adds no constraint. Checking each distinct word once keeps the per-entry
  // work bounded by the entry's own words rather than by the length of the query.
  const distinct = [...new Set(words)];
  for (const { entry, words: entryWords, starts, compactStarts } of index.words) {
    if (ranks.has(entry)) continue;
    if (distinct.every((word) => entryWords.has(word))) ranks.set(entry, RANK_WHOLE_WORDS);
    else if (
      distinct.every((word) => starts.some((start) => start.startsWith(word))) ||
      compactStarts.some((start) => start.startsWith(key))
    )
      ranks.set(entry, RANK_WORD_START);
  }
  return ranks;
}

export class ReferenceDataService {
  private indices = new Map<ReferenceCategory, CategoryIndex>();

  /** Vintage of the data the indices actually hold, not of the bundle they may have replaced. */
  private activeDate: string = REFERENCE_SNAPSHOT_DATE;

  private activeSource: ReferenceSource = 'bundled';

  constructor(private readonly serverConfig: ServerConfig) {}

  /** Load the bundled snapshot, optionally refresh from the live endpoint, then build indices. */
  async setup(): Promise<void> {
    this.activeDate = REFERENCE_SNAPSHOT_DATE;
    this.activeSource = 'bundled';
    let data: Record<ReferenceCategory, ReferenceEntry[]> = {
      connectiontypes: [...REFERENCE_SNAPSHOT.connectiontypes],
      operators: [...REFERENCE_SNAPSHOT.operators],
      usagetypes: [...REFERENCE_SNAPSHOT.usagetypes],
      statustypes: [...REFERENCE_SNAPSHOT.statustypes],
      currenttypes: [...REFERENCE_SNAPSHOT.currenttypes],
      levels: [...REFERENCE_SNAPSHOT.levels],
      countries: [...REFERENCE_SNAPSHOT.countries],
    };

    if (this.serverConfig.referenceRefresh) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        data = refreshed;
        // `/referencedata` carries no dataset date or version, and its response has no
        // Last-Modified or ETag header — the moment the fetch succeeded is the only vintage
        // signal the endpoint offers. `tryRefresh` returns undefined on every failure mode, so
        // reaching here is what makes the live set active and the live date true.
        this.activeDate = new Date().toISOString().slice(0, 10);
        this.activeSource = 'live';
      }
    }

    this.buildIndices(data);
  }

  /**
   * Date the reference data now in memory was captured — the day of a successful live refresh, or
   * the bundled snapshot's own capture date when the bundle is what is being served.
   */
  get snapshotDate(): string {
    return this.activeDate;
  }

  /** Which of the two sources the active data came from. Pairs with {@link snapshotDate}. */
  get source(): ReferenceSource {
    return this.activeSource;
  }

  /** The `find_stations` filter param a category's IDs feed, or undefined when there is none. */
  filterParam(category: ReferenceCategory): string | undefined {
    return FILTER_PARAM[category];
  }

  /** Whether the active bundled or refreshed countries index contains this ISO code. */
  hasCountryCode(code: string): boolean {
    const normalizedCode = code.toUpperCase();
    return this.requireIndex('countries').entries.some(
      (entry) => entry.ISOCode?.toUpperCase() === normalizedCode,
    );
  }

  /**
   * Resolve a query to matching reference entries within a category, best first. Each query word
   * must start a word of the title or formal name — a delimited word or a CamelCase / letter–number
   * sub-word — in any order, so "UK" never matches inside "Ukraine"; case, diacritics, and
   * separators are ignored, and a leading "the" is optional. Ranks every match (see
   * {@link rankMatches}), ties by ascending ID, then returns the `[offset, offset + limit)` window
   * alongside the full match count so the caller can disclose and page what the window left out.
   * `total: 0` means no match (caller surfaces a browse hint).
   */
  resolve(category: ReferenceCategory, query: string, limit: number, offset = 0): ReferencePage {
    const index = this.requireIndex(category);
    const words = queryWords(query);
    if (words.length === 0) return { matches: [], total: 0 };

    const ranks = rankMatches(index, words);
    if (words[0] === 'the' && words.length > 1) {
      for (const [entry, rank] of rankMatches(index, words.slice(1))) {
        const current = ranks.get(entry);
        if (current === undefined || rank < current) ranks.set(entry, rank);
      }
    }

    const ordered = [...ranks]
      .sort(([a, rankA], [b, rankB]) => rankA - rankB || a.ID - b.ID)
      .map(([entry]) => entry);
    return {
      matches: ordered.slice(offset, offset + limit).map((e) => this.toMatch(category, e)),
      total: ordered.length,
    };
  }

  /**
   * Browse a full category, ordered by ID. Returns the `[offset, offset + limit)` window and the
   * full category total, so the caller can disclose and page what the window left out.
   */
  browse(category: ReferenceCategory, limit: number, offset = 0): ReferencePage {
    const index = this.requireIndex(category);
    const matches = index.entries
      .slice(offset, offset + limit)
      .map((e) => this.toMatch(category, e));
    return { matches, total: index.entries.length };
  }

  /** Human-readable title for a numeric ID within a category, or undefined when not found. */
  labelFor(category: ReferenceCategory, id: number | null | undefined): string | undefined {
    if (id == null) return;
    return this.indices.get(category)?.byId.get(id)?.Title;
  }

  // --- internals ---

  private requireIndex(category: ReferenceCategory): CategoryIndex {
    const index = this.indices.get(category);
    if (!index) {
      throw new Error(
        `ReferenceDataService not initialized for category "${category}" — call setup() in createApp().`,
      );
    }
    return index;
  }

  private buildIndices(data: Record<ReferenceCategory, ReferenceEntry[]>): void {
    this.indices.clear();
    for (const category of Object.keys(data) as ReferenceCategory[]) {
      const entries = [...data[category]].sort((a, b) => a.ID - b.ID);
      const byId = new Map(entries.map((e) => [e.ID, e]));

      const exact = new Map<string, ReferenceEntry[]>();
      for (const entry of entries) {
        const keys = new Set(
          [entry.Title, entry.FormalName, entry.ISOCode]
            .filter((field): field is string => !!field)
            .map(compactKey),
        );
        for (const key of keys) exact.set(key, [...(exact.get(key) ?? []), entry]);
      }

      this.indices.set(category, {
        entries,
        byId,
        words: entries.map(indexWords),
        exact,
        aliases: aliasTargets(category, entries, byId),
      });
    }
  }

  private toMatch(category: ReferenceCategory, entry: ReferenceEntry): ReferenceMatch {
    const detail = this.detailFor(category, entry);
    return {
      id: entry.ID,
      title: entry.Title,
      ...(entry.FormalName !== undefined ? { formalName: entry.FormalName } : {}),
      ...(entry.ISOCode ? { isoCode: entry.ISOCode } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  private detailFor(category: ReferenceCategory, entry: ReferenceEntry): string | undefined {
    switch (category) {
      case 'connectiontypes': {
        const flags: string[] = [];
        if (entry.IsDiscontinued) flags.push('discontinued');
        if (entry.IsObsolete) flags.push('obsolete');
        return flags.length ? flags.join(', ') : undefined;
      }
      case 'usagetypes': {
        const flags: string[] = [];
        if (entry.IsPayAtLocation) flags.push('pay at location');
        if (entry.IsMembershipRequired) flags.push('membership required');
        if (entry.IsAccessKeyRequired) flags.push('access key required');
        return flags.length ? flags.join(', ') : undefined;
      }
      case 'statustypes': {
        // Two statuses carry an operational flag their own title contradicts — say what the title
        // means so a caller reading the list is not told a down station counts as operational.
        const availability = statusAvailability(entry.ID);
        if (availability === 'unavailable')
          return 'flagged operational upstream, but currently unavailable';
        if (availability === 'partial')
          return 'flagged operational upstream, but only part of the site works';
        if (entry.IsOperational === true) return 'counts as operational';
        if (entry.IsOperational === false) return 'counts as non-operational';
        return 'operational state unknown';
      }
      case 'levels':
        return entry.IsFastChargeCapable ? 'fast-charge capable' : undefined;
      case 'currenttypes':
        return entry.Description ?? undefined;
      case 'countries':
        return entry.ContinentCode ? `continent ${entry.ContinentCode}` : undefined;
      default:
        return;
    }
  }

  /** Attempt a live reference refresh; returns the parsed set on success, undefined on any failure. */
  private async tryRefresh(): Promise<Record<ReferenceCategory, ReferenceEntry[]> | undefined> {
    const reqCtx = requestContextService.createRequestContext({
      operation: 'referenceDataRefresh',
    });
    try {
      const url = `${this.serverConfig.baseUrl}/referencedata?output=json`;
      const response = await fetchWithTimeout(url, 15_000, reqCtx, {
        headers: { 'X-API-Key': this.serverConfig.apiKey },
      });
      const raw = (await response.json()) as Record<string, unknown>;

      const result = {} as Record<ReferenceCategory, ReferenceEntry[]>;
      for (const category of Object.keys(LIVE_CATEGORY_KEYS) as ReferenceCategory[]) {
        const liveKey = LIVE_CATEGORY_KEYS[category];
        const list = raw[liveKey];
        if (!Array.isArray(list)) {
          logger.warning(
            'Reference refresh missing category; keeping bundled snapshot',
            withExtra(reqCtx, { category: liveKey }),
          );
          return;
        }
        result[category] = (list as ReferenceEntry[]).map((e) => ({ ...e }));
      }
      logger.info('Reference data refreshed from live endpoint', reqCtx);
      return result;
    } catch (error) {
      logger.warning(
        'Reference refresh failed; keeping bundled snapshot',
        withExtra(reqCtx, { error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
  }
}

// --- Init/accessor pattern ---

let _service: ReferenceDataService | undefined;

/** Construct and initialize the reference-data service. Awaited in `createApp()`'s `setup()`. */
export async function initReferenceDataService(serverConfig: ServerConfig): Promise<void> {
  const service = new ReferenceDataService(serverConfig);
  await service.setup();
  _service = service;
}

/** Accessor for the initialized reference-data service. */
export function getReferenceDataService(): ReferenceDataService {
  if (!_service) {
    throw new Error(
      'ReferenceDataService not initialized — call initReferenceDataService() in setup()',
    );
  }
  return _service;
}

/** Reset the singleton (test isolation only). */
export function resetReferenceDataService(): void {
  _service = undefined;
}
