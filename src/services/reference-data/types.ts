/**
 * @fileoverview Domain types for the reference-data service.
 * @module services/reference-data/types
 */

/** The reference categories this server resolves. */
export type ReferenceCategory =
  | 'connectiontypes'
  | 'operators'
  | 'usagetypes'
  | 'statustypes'
  | 'currenttypes'
  | 'levels'
  | 'countries';

/** A resolved reference match, shaped for `openchargemap_lookup_reference` output. */
export interface ReferenceMatch {
  /** Extra interpretive context (operational flag, pay/membership/access, discontinued). */
  detail?: string;
  /** Formal/standard name where applicable (connection types). null when none. */
  formalName?: string | null;
  /** Numeric OCM reference ID. */
  id: number;
  /** ISO 3166-1 alpha-2 code — countries only. */
  isoCode?: string;
  /** Human-readable title. */
  title: string;
}

/**
 * Where the reference data now in memory came from. `live` only once a startup refresh returned a
 * complete set; `bundled` covers both "refresh disabled" and "refresh failed, fell back" — either
 * way the shipped snapshot is what is being served, which is the fact a caller acts on.
 */
export type ReferenceSource = 'live' | 'bundled';

/**
 * One window over a category's entries — what `resolve` and `browse` both return. `total` is the
 * complete match count, not the window's length, so the caller can disclose and page the remainder.
 */
export interface ReferencePage {
  /** The requested `[offset, offset + limit)` slice. */
  matches: ReferenceMatch[];
  /** Entries matching before the window was applied. */
  total: number;
}
