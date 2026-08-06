/**
 * @fileoverview Shared Zod schema fragments for station output, reused across all tools: the
 * station shape (used by find and detail), connection shape, address shape, comment shape (used by
 * get_station and get_station_comments), and the markdown renderers that keep format()↔content[]
 * parity in one place.
 * @module mcp-server/tools/definitions/_station-schema
 */

import { z } from '@cyanheads/mcp-ts-core';
import { isFaultComment, statusAvailability } from '@/services/openchargemap/attribution.js';

/** Structured station address + coordinates. */
export const AddressSchema = z
  .object({
    line1: z.string().optional().describe('Street address line.'),
    town: z.string().optional().describe('Town or city.'),
    stateOrProvince: z.string().optional().describe('State or province.'),
    postcode: z.string().optional().describe('Postal/ZIP code.'),
    country: z.string().optional().describe('Country name.'),
    countryCode: z.string().optional().describe('ISO 3166-1 alpha-2 country code.'),
    latitude: z.number().describe('Station latitude (WGS84).'),
    longitude: z.number().describe('Station longitude (WGS84).'),
    accessComments: z
      .string()
      .optional()
      .describe('Free-text access notes (e.g. "24 hours daily").'),
  })
  .describe('Structured station address and coordinates.');

/** A single connector at a station. */
export const ConnectionSchema = z
  .object({
    connectionTypeId: z
      .number()
      .optional()
      .describe('Connector type ID — resolve via openchargemap_lookup_reference.'),
    connectionType: z
      .string()
      .optional()
      .describe('Connector type title (e.g. "CCS (Type 2)", "CHAdeMO").'),
    level: z
      .string()
      .optional()
      .describe('Charge level title (e.g. "Level 2 : Medium (Over 2kW)").'),
    levelId: z.number().optional().describe('Charge level ID (1/2/3).'),
    powerKW: z
      .number()
      .nullable()
      .optional()
      .describe('Rated power in kW for this connection. null/absent when unknown.'),
    currentType: z.string().optional().describe('Current type (e.g. "AC (Single-Phase)", "DC").'),
    amps: z.number().nullable().optional().describe('Rated amperage. Often null.'),
    voltage: z.number().nullable().optional().describe('Rated voltage. Often null.'),
    quantity: z
      .number()
      .nullable()
      .optional()
      .describe('Number of connectors of this type. null when unknown.'),
  })
  .describe('A connector at the station.');

/** A community check-in or comment, shared by openchargemap_get_station and openchargemap_get_station_comments. */
export const CommentSchema = z
  .object({
    user: z.string().optional().describe('Commenter username. Absent for anonymous.'),
    commentType: z
      .string()
      .optional()
      .describe('Comment type (e.g. "General Comment", "Fault Report").'),
    checkinStatus: z
      .string()
      .optional()
      .describe(
        'The visit outcome the driver recorded (e.g. "Charged Successfully", "Failed to Charge (Equipment Not Operational)"). Carries the result on check-ins that have no comment text. Absent when the visitor recorded no outcome.',
      ),
    checkinStatusId: z
      .number()
      .optional()
      .describe('Numeric ID of the check-in outcome, stable across renames of its title.'),
    checkinStatusIsPositive: z
      .boolean()
      .optional()
      .describe(
        'Whether the registry classes this outcome as a good visit. Absent when the outcome carries no verdict either way (e.g. "Did Not Visit Location") or when none was recorded.',
      ),
    comment: z.string().optional().describe('Comment text.'),
    rating: z.number().nullable().optional().describe('User rating 1–5. null when not given.'),
    relatedUrl: z
      .string()
      .optional()
      .describe('Link the commenter attached. Absent when none was given.'),
    dateCreated: z.string().optional().describe('ISO 8601 timestamp the comment was posted.'),
  })
  .describe('A community check-in or comment.');

/** Comment type inferred from {@link CommentSchema} — the shape `format()` receives post-parse. */
export type Comment = z.infer<typeof CommentSchema>;

/** The core station shape shared by search results and detail. */
export const StationSchema = z
  .object({
    id: z.number().describe('OCM station ID.'),
    uuid: z
      .string()
      .describe(
        'OCM station UUID — stable cross-system identifier (cannot be used as a lookup input).',
      ),
    title: z.string().describe('Station name / location title.'),
    address: AddressSchema,
    distance: z
      .number()
      .optional()
      .describe('Distance from the search point. Absent for bounding-box searches.'),
    distanceUnit: z.enum(['KM', 'Miles']).optional().describe('Unit of the distance value.'),
    operator: z
      .string()
      .optional()
      .describe(
        'Operating network name (e.g. "ChargePoint", "Tesla"). Absent when OCM has no operator on record.',
      ),
    operatorId: z
      .number()
      .optional()
      .describe('OCM operator ID — resolve names via openchargemap_lookup_reference.'),
    usageType: z
      .string()
      .optional()
      .describe(
        'Access/usage type title (e.g. "Public", "Public - Pay At Location"). Absent when OCM has no usage type.',
      ),
    isPayAtLocation: z
      .boolean()
      .optional()
      .describe('Whether payment is required at the location. Absent when usage type is unknown.'),
    isMembershipRequired: z
      .boolean()
      .optional()
      .describe(
        'Whether a membership or RFID card is required. Absent when usage type is unknown.',
      ),
    isAccessKeyRequired: z
      .boolean()
      .optional()
      .describe('Whether a physical access key is required. Absent when usage type is unknown.'),
    numberOfPoints: z
      .number()
      .optional()
      .describe(
        'Reported number of charge points (stalls). Often absent — absence means unknown, not zero.',
      ),
    status: z
      .string()
      .optional()
      .describe(
        'Registry operational status (e.g. "Operational", "Temporarily Unavailable"). Operator-reported; may be stale.',
      ),
    statusTypeId: z
      .number()
      .optional()
      .describe(
        'Registry status ID — the value the openchargemap_find_stations statustypeid filter takes. Absent when OCM has no status on record.',
      ),
    isOperational: z
      .boolean()
      .optional()
      .describe(
        'Whether the registry marks the status operational. Absent when the operational state is unknown. A true value can still mask a broken charger — corroborate with comments and dateLastVerified.',
      ),
    dateLastVerified: z
      .string()
      .nullable()
      .optional()
      .describe(
        'ISO 8601 date the listing was last verified. Stale (>12 months) is a reliability caveat. null when never verified.',
      ),
    isRecentlyVerified: z
      .boolean()
      .optional()
      .describe('Whether the listing was verified recently.'),
    connections: z
      .array(ConnectionSchema)
      .describe('Connectors at the station. Empty when OCM has no connection data on record.'),
    dataProvider: z
      .string()
      .optional()
      .describe('Source that provided the listing (e.g. "afdc.energy.gov").'),
  })
  .describe('A charging station record.');

/** Station type inferred from {@link StationSchema} — the shape `format()` receives post-parse. */
export type Station = z.infer<typeof StationSchema>;

/**
 * Render a three-state flag as `label: yes` / `label: no`, or nothing when the value is absent.
 * Absent means OCM has no fact on record; an explicit `false` IS a fact and must reach the text,
 * or a client reading only `content[]` sees it as unknown.
 */
function renderFlag(value: boolean | undefined, label: string): string | undefined {
  return value === undefined ? undefined : `${label}: ${value ? 'yes' : 'no'}`;
}

/** Render one connection as a compact line covering every connection field. */
function renderConnection(c: Station['connections'][number]): string {
  const parts: string[] = [c.connectionType ?? 'Unknown connector'];
  if (c.connectionTypeId != null) parts.push(`typeId ${c.connectionTypeId}`);
  if (c.level) parts.push(c.level);
  if (c.levelId != null) parts.push(`levelId ${c.levelId}`);
  if (c.powerKW != null) parts.push(`${c.powerKW} kW`);
  if (c.currentType) parts.push(c.currentType);
  if (c.amps != null) parts.push(`${c.amps}A`);
  if (c.voltage != null) parts.push(`${c.voltage}V`);
  const head = parts.join(' · ');
  return c.quantity != null ? `${head} ×${c.quantity}` : head;
}

/** Render one station as a markdown block. Shared by find/detail format() so parity holds. */
export function renderStationBlock(s: Station): string {
  const lines: string[] = [];
  const dist = s.distance != null ? ` — ${s.distance.toFixed(2)} ${s.distanceUnit ?? 'KM'}` : '';
  lines.push(`**${s.title}**${dist}  _(id ${s.id}, uuid ${s.uuid})_`);

  const addrBits = [
    s.address.line1,
    s.address.town,
    s.address.stateOrProvince,
    s.address.postcode,
    s.address.country,
    s.address.countryCode ? `(${s.address.countryCode})` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  if (addrBits) lines.push(addrBits);
  lines.push(`Coordinates: ${s.address.latitude}, ${s.address.longitude}`);
  if (s.address.accessComments) lines.push(`Access: ${s.address.accessComments}`);

  const opUsage: string[] = [];
  if (s.operator)
    opUsage.push(`Operator: ${s.operator}${s.operatorId != null ? ` (id ${s.operatorId})` : ''}`);
  if (s.usageType) opUsage.push(`Usage: ${s.usageType}`);
  const accessFlags = [
    renderFlag(s.isPayAtLocation, 'pay at location'),
    renderFlag(s.isMembershipRequired, 'membership required'),
    renderFlag(s.isAccessKeyRequired, 'access key required'),
  ].filter(Boolean);
  if (accessFlags.length) opUsage.push(accessFlags.join(', '));
  if (opUsage.length) lines.push(opUsage.join(' · '));

  if (s.numberOfPoints != null) lines.push(`Charge points: ${s.numberOfPoints}`);
  if (s.dataProvider) lines.push(`Data provider: ${s.dataProvider}`);

  if (s.connections.length > 0) {
    lines.push('Connections:');
    for (const c of s.connections) lines.push(`  - ${renderConnection(c)}`);
  } else {
    lines.push('Connections: none on record');
  }

  lines.push(renderStatusLine(s));

  return lines.join('\n');
}

/**
 * Status line with explicit reliability caveat. Render dateLastVerified raw (no slice) so
 * format-parity sees the full value; the recency flag rides alongside.
 */
function renderStatusLine(s: Station): string {
  const id = s.statusTypeId != null ? ` (status id ${s.statusTypeId})` : '';
  const verified = s.dateLastVerified ? `last verified ${s.dateLastVerified}` : 'never verified';
  const recency = renderFlag(s.isRecentlyVerified, 'recently verified');
  const recencyText = recency ? ` (${recency})` : '';
  return `Status: ${s.status ?? 'Unknown'}${id} — ${renderOperationalText(s.statusTypeId, s.isOperational)} · ${verified}${recencyText}`;
}

/**
 * Describe how usable the station is. OCM marks "Temporarily Unavailable" and "Partly Operational
 * (Mixed)" as operational, so on those two the flag alone would read as all-clear — the availability
 * leads and the raw flag follows, named as the flag it is rather than as a verdict.
 */
export function renderOperationalText(
  statusTypeId: number | undefined,
  isOperational: boolean | undefined,
): string {
  const flag = renderFlag(isOperational, 'operational flag') ?? 'operational flag: unknown';
  switch (statusAvailability(statusTypeId)) {
    case 'unavailable':
      return `not usable right now (${flag})`;
    case 'partial':
      return `only partly usable (${flag})`;
    default:
      return isOperational === true
        ? 'operational'
        : isOperational === false
          ? 'NOT operational'
          : 'operational state unknown';
  }
}

/**
 * Split a comment list into the rows worth rendering and a count of those with nothing to say.
 * A row is worth rendering when it carries anything a reader can act on — text, a rating, a
 * check-in outcome, a link, or a problem report. What is left is a bare username and date, and OCM
 * has stations whose entire comment list is that shape, so text output names the count instead of
 * emitting a run of blank rows. Nothing is dropped from the structured output.
 */
export function visibleComments(comments: Comment[]): { shown: Comment[]; omitted: number } {
  const shown = comments.filter(
    (c) =>
      c.comment?.trim() ||
      c.rating != null ||
      c.checkinStatus ||
      c.checkinStatusId != null ||
      c.relatedUrl ||
      isFaultComment(c),
  );
  return { shown, omitted: comments.length - shown.length };
}

/** Render one comment line, covering every comment field. */
export function renderComment(c: Comment): string {
  const date = c.dateCreated ? `[${c.dateCreated}] ` : '';
  const user = c.user ?? 'anonymous';
  const checkin = c.checkinStatus
    ? `${c.checkinStatus}${c.checkinStatusId != null ? ` #${c.checkinStatusId}` : ''}`
    : undefined;
  const meta = [
    c.commentType,
    c.rating != null ? `★${c.rating}` : undefined,
    checkin,
    renderFlag(c.checkinStatusIsPositive, 'good visit'),
  ]
    .filter(Boolean)
    .join(', ');
  const tag = meta ? ` (${meta})` : '';
  // Only open the colon when something follows it, or a check-in whose whole meaning is the
  // outcome renders as a line ending in a dangling separator.
  const body = [c.comment?.trim(), c.relatedUrl].filter(Boolean).join(' ');
  return `${date}${user}${tag}${body ? `: ${body}` : ''}`;
}
