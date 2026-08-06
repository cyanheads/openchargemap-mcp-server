/**
 * @fileoverview Shared Open Charge Map attribution string, the status-availability classifier, and
 * the reliability-note helper — plain-prose caveats derived from observable facts (verification age,
 * operational flag, status availability, placeholder 0,0 coordinates, fault-vs-positive check-in
 * counts). No synthetic score (per the no-fabricated-signal rule).
 * @module services/openchargemap/attribution
 */

import type { NormalizedComment } from './types.js';

/** Mandatory CC BY 4.0 attribution, surfaced in every tool's output. */
export const ATTRIBUTION =
  'Station data © Open Charge Map contributors, licensed under CC BY 4.0 (openchargemap.org).';

/** Months past which a listing's last-verified date is treated as a staleness caveat. */
const STALE_MONTHS = 12;

/** Status ID whose title says the station is down while OCM still flags it operational. */
const STATUS_TEMPORARILY_UNAVAILABLE = 30;

/** Status ID for a site where only some equipment works; OCM also flags this one operational. */
const STATUS_PARTLY_OPERATIONAL = 75;

/**
 * How usable a registry status says the station is right now, independent of OCM's `IsOperational`
 * boolean. Only the two statuses whose title contradicts that boolean are classified; every other
 * status agrees with the flag and returns undefined so the flag speaks for itself.
 */
export function statusAvailability(
  statusTypeId: number | undefined,
): 'unavailable' | 'partial' | undefined {
  if (statusTypeId === STATUS_TEMPORARILY_UNAVAILABLE) return 'unavailable';
  if (statusTypeId === STATUS_PARTLY_OPERATIONAL) return 'partial';
  return;
}

/** Whole months between an ISO date and now; null when the date is missing/unparseable. */
function monthsSince(dateLastVerified: string | null | undefined): number | null {
  if (!dateLastVerified) return null;
  const then = Date.parse(dateLastVerified);
  if (Number.isNaN(then)) return null;
  const msPerMonth = 1000 * 60 * 60 * 24 * 30.44;
  return Math.floor((Date.now() - then) / msPerMonth);
}

/**
 * True when a comment reports a bad visit. The check-in outcome is the primary signal — OCM marks
 * all but one of its 18 outcomes positive or negative ("Did Not Visit Location" carries no verdict),
 * and a failed charge is routinely filed under the "General Comment" type. A fault-report comment
 * type still counts on its own, since it flags a problem even when the visitor recorded a positive
 * or no check-in. Shared with the comment renderers so a row this counts is never left unlisted.
 */
export function isFaultComment(c: {
  commentType?: string | undefined;
  checkinStatusIsPositive?: boolean | undefined;
}): boolean {
  if (c.checkinStatusIsPositive === false) return true;
  const t = c.commentType?.toLowerCase() ?? '';
  return t.includes('fault') || t.includes('problem') || t.includes('issue');
}

/**
 * Compose a plain-prose reliability caveat from observable facts, or undefined when there is
 * nothing to flag (status fresh, operational, no fault reports).
 */
export function buildReliabilityNote(input: {
  status: string | undefined;
  statusTypeId?: number | undefined;
  isOperational: boolean | undefined;
  dateLastVerified: string | null | undefined;
  comments: NormalizedComment[] | undefined;
  coordinates?: { latitude: number; longitude: number };
}): string | undefined {
  const parts: string[] = [];

  const badCoordinates = input.coordinates?.latitude === 0 && input.coordinates?.longitude === 0;
  if (badCoordinates) {
    parts.push(
      'Coordinates are recorded as 0,0 — a placeholder, not a real location; do not use them for distance or navigation.',
    );
  }

  const months = monthsSince(input.dateLastVerified);
  const stale = months !== null && months >= STALE_MONTHS;

  // Availability comes first: OCM flags both of these statuses operational, so the flag alone
  // would read as all-clear on a station the operator has said is down or only partly working.
  const availability = statusAvailability(input.statusTypeId);
  if (availability === 'unavailable') {
    parts.push(
      `Registry status is "${input.status ?? 'Temporarily Unavailable'}" — the station is not usable right now.`,
    );
  } else if (availability === 'partial') {
    parts.push(
      `Registry status is "${input.status ?? 'Partly Operational (Mixed)'}" — only some equipment here is working.`,
    );
  } else if (input.isOperational === false) {
    parts.push(`Registry status is "${input.status ?? 'non-operational'}" (not operational).`);
  } else if (input.isOperational === undefined && input.status) {
    parts.push(`Registry operational state is unknown (status "${input.status}").`);
  }

  if (stale) {
    const flagCaveat =
      input.isOperational === true && !availability
        ? ', so the "operational" flag may be out of date'
        : '';
    parts.push(`Last verified ${months} months ago${flagCaveat}.`);
  } else if (months === null) {
    parts.push('Listing has never been verified.');
  }

  if (input.comments && input.comments.length > 0) {
    const faults = input.comments.filter(isFaultComment).length;
    if (faults > 0) {
      parts.push(
        `${faults} of ${input.comments.length} recent comment(s) report a fault or a failed visit.`,
      );
    }
  }

  // Only emit a note when at least one concrete caveat fired and the picture isn't all-clear.
  if (parts.length === 0) return;
  // Suppress a lone "operational unknown" caveat when the listing is fresh and uncontested — but a
  // bad-coordinate flag is a hard data-quality problem that must always surface.
  if (
    parts.length === 1 &&
    !badCoordinates &&
    input.isOperational === undefined &&
    !stale &&
    months !== null
  ) {
    return;
  }
  return parts.join(' ');
}
