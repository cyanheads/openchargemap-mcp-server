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
