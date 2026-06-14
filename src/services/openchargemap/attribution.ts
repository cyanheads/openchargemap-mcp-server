/**
 * @fileoverview Shared Open Charge Map attribution string and the reliability-note helper —
 * plain-prose caveats derived from observable facts (verification age, operational flag,
 * fault-vs-positive comment counts). No synthetic score (per the no-fabricated-signal rule).
 * @module services/openchargemap/attribution
 */

import type { NormalizedComment } from './types.js';

/** Mandatory CC BY 4.0 attribution, surfaced in every tool's output. */
export const ATTRIBUTION =
  'Station data © Open Charge Map contributors, licensed under CC BY 4.0 (openchargemap.org).';

/** Months past which a listing's last-verified date is treated as a staleness caveat. */
const STALE_MONTHS = 12;

/** Whole months between an ISO date and now; null when the date is missing/unparseable. */
function monthsSince(dateLastVerified: string | null | undefined): number | null {
  if (!dateLastVerified) return null;
  const then = Date.parse(dateLastVerified);
  if (Number.isNaN(then)) return null;
  const msPerMonth = 1000 * 60 * 60 * 24 * 30.44;
  return Math.floor((Date.now() - then) / msPerMonth);
}

/** True when a comment's type reads as a fault/problem report. */
function isFaultComment(c: NormalizedComment): boolean {
  const t = c.commentType?.toLowerCase() ?? '';
  return t.includes('fault') || t.includes('problem') || t.includes('issue');
}

/**
 * Compose a plain-prose reliability caveat from observable facts, or undefined when there is
 * nothing to flag (status fresh, operational, no fault reports).
 */
export function buildReliabilityNote(input: {
  status: string | undefined;
  isOperational: boolean | undefined;
  dateLastVerified: string | null | undefined;
  comments: NormalizedComment[] | undefined;
}): string | undefined {
  const parts: string[] = [];

  const months = monthsSince(input.dateLastVerified);
  const stale = months !== null && months >= STALE_MONTHS;

  if (input.isOperational === false) {
    parts.push(`Registry status is "${input.status ?? 'non-operational'}" (not operational).`);
  } else if (input.isOperational === undefined && input.status) {
    parts.push(`Registry operational state is unknown (status "${input.status}").`);
  }

  if (stale) {
    parts.push(
      `Last verified ${months} months ago${input.isOperational === true ? ', so the "operational" flag may be out of date' : ''}.`,
    );
  } else if (months === null) {
    parts.push('Listing has never been verified.');
  }

  if (input.comments && input.comments.length > 0) {
    const faults = input.comments.filter(isFaultComment).length;
    if (faults > 0) {
      parts.push(`${faults} of ${input.comments.length} recent comment(s) report a fault.`);
    }
  }

  // Only emit a note when at least one concrete caveat fired and the picture isn't all-clear.
  if (parts.length === 0) return;
  // Suppress a lone "unknown" caveat when the listing is fresh and uncontested.
  if (parts.length === 1 && input.isOperational === undefined && !stale && months !== null) {
    return;
  }
  return parts.join(' ');
}
