/**
 * @fileoverview Reference-data service — resolves Open Charge Map reference names/codes to the
 * integer IDs that POI filters key on, served from a bundled snapshot (offline, zero-latency).
 * Builds per-category lookup indices (exact-ID, normalized-title, curated connector aliases) at
 * init, with an optional startup refresh from the live `/v3/referencedata` endpoint that falls
 * back to the bundled snapshot on any failure.
 * @module services/reference-data/reference-data-service
 */

import { fetchWithTimeout, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import {
  REFERENCE_SNAPSHOT,
  REFERENCE_SNAPSHOT_DATE,
  type ReferenceEntry,
} from '@/data/ocm-reference-data.js';
import type { ReferenceCategory, ReferenceMatch } from './types.js';

/** The `find_stations` input parameter each category's IDs feed (omitted where there's no direct filter). */
const FILTER_PARAM: Partial<Record<ReferenceCategory, string>> = {
  connectiontypes: 'connectiontypeid',
  operators: 'operatorid',
  usagetypes: 'usagetypeid',
  statustypes: 'statustypeid',
  levels: 'levelid',
};

/**
 * Curated aliases for the connectors agents actually name → connection-type IDs, in priority order.
 * Each token resolves to one or more IDs; the first ID listed ranks first in results.
 */
const CONNECTOR_ALIASES: Record<string, number[]> = {
  j1772: [1],
  'type 1': [1],
  ccs: [33, 32],
  'ccs type 2': [33],
  'ccs type 1': [32],
  'ccs combo': [33, 32],
  combo: [33, 32],
  supercharger: [27],
  'tesla supercharger': [27],
  nacs: [27],
  'tesla nacs': [27],
  'type 2': [25, 1036],
  mennekes: [25, 1036],
  chademo: [2],
  chaoji: [1044],
};

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

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Per-category index: ordered entries, ID lookup, normalized-title list. */
interface CategoryIndex {
  byId: Map<number, ReferenceEntry>;
  entries: ReferenceEntry[];
}

export class ReferenceDataService {
  private indices = new Map<ReferenceCategory, CategoryIndex>();

  constructor(private readonly serverConfig: ServerConfig) {}

  /** Load the bundled snapshot, optionally refresh from the live endpoint, then build indices. */
  async setup(): Promise<void> {
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
      if (refreshed) data = refreshed;
    }

    this.buildIndices(data);
  }

  /** Date the active reference data was captured (bundled snapshot vintage). */
  get snapshotDate(): string {
    return REFERENCE_SNAPSHOT_DATE;
  }

  /** The `find_stations` filter param a category's IDs feed, or undefined when there is none. */
  filterParam(category: ReferenceCategory): string | undefined {
    return FILTER_PARAM[category];
  }

  /**
   * Resolve a query to matching reference entries within a category, best/exact first.
   * Strict normalized token match over the complete category set, plus curated connector aliases.
   * Returns up to `limit` matches; an empty array means no match (caller surfaces a browse hint).
   */
  resolve(category: ReferenceCategory, query: string, limit: number): ReferenceMatch[] {
    const index = this.requireIndex(category);
    const normalizedQuery = normalize(query);
    if (normalizedQuery.length === 0) return [];

    const ranked = new Map<number, number>(); // id → rank (lower is better)

    // 1. Curated aliases (connection types only) take top priority.
    if (category === 'connectiontypes') {
      const aliasIds = CONNECTOR_ALIASES[normalizedQuery];
      if (aliasIds) aliasIds.forEach((id, i) => void ranked.set(id, i));
    }

    // 2. Exact title / formal-name / ISO-code match.
    const queryTokens = normalizedQuery.split(' ').filter(Boolean);
    for (const entry of index.entries) {
      if (ranked.has(entry.ID)) continue;
      const title = normalize(entry.Title);
      const formal = entry.FormalName ? normalize(entry.FormalName) : '';
      const iso = entry.ISOCode ? entry.ISOCode.toLowerCase() : '';

      if (title === normalizedQuery || formal === normalizedQuery || iso === normalizedQuery) {
        ranked.set(entry.ID, 100);
      }
    }

    // 3. Token-subset match: every query token appears in title or formal name.
    for (const entry of index.entries) {
      if (ranked.has(entry.ID)) continue;
      const hay = `${normalize(entry.Title)} ${entry.FormalName ? normalize(entry.FormalName) : ''}`;
      if (queryTokens.every((t) => hay.includes(t))) {
        ranked.set(entry.ID, 200);
      }
    }

    const matches: ReferenceMatch[] = [];
    for (const [id] of [...ranked.entries()].sort((a, b) => a[1] - b[1])) {
      if (matches.length >= limit) break;
      const entry = index.byId.get(id);
      if (entry) matches.push(this.toMatch(category, entry));
    }
    return matches;
  }

  /** Browse a full category, ordered by ID, up to `limit`. Returns the total count for truncation. */
  browse(category: ReferenceCategory, limit: number): { matches: ReferenceMatch[]; total: number } {
    const index = this.requireIndex(category);
    const matches = index.entries.slice(0, limit).map((e) => this.toMatch(category, e));
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
      this.indices.set(category, { entries, byId });
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
      case 'statustypes':
        if (entry.IsOperational === true) return 'counts as operational';
        if (entry.IsOperational === false) return 'counts as non-operational';
        return 'operational state unknown';
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
          logger.warning('Reference refresh missing category; keeping bundled snapshot', {
            ...reqCtx,
            category: liveKey,
          });
          return;
        }
        result[category] = (list as ReferenceEntry[]).map((e) => ({ ...e }));
      }
      logger.info('Reference data refreshed from live endpoint', { ...reqCtx });
      return result;
    } catch (error) {
      logger.warning('Reference refresh failed; keeping bundled snapshot', {
        ...reqCtx,
        error: error instanceof Error ? error.message : String(error),
      });
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
