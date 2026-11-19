/**
 * @fileoverview Shared Zod schema fragments for station output, reused across all tools: the
 * station shape (used by find and detail), connection shape, address shape, comment shape (used by
 * get_station and get_station_comments), and the markdown renderers that keep format()↔content[]
 * parity in one place.
 * @module mcp-server/tools/definitions/_station-schema
 */

import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { statusAvailability } from '@/services/openchargemap/attribution.js';

/** Structured station address + coordinates. */
export const AddressSchema = z
  .object({
    line1: z.string().optional().describe('Street address line.'),
    line2: z
      .string()
      .optional()
      .describe('Second address line (e.g. a district or building). Absent when none on record.'),
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
    statusTypeId: z
      .number()
      .optional()
      .describe('Registry status ID for this connector; absent when no status ID is on record.'),
    status: z.string().optional().describe('Registry status title for this connector.'),
    isOperational: z
      .boolean()
      .optional()
      .describe('Faithful registry operational flag for this connector; absent when unknown.'),
    notes: z.string().optional().describe('Provider notes about this connector.'),
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
    dataProviderLicense: z
      .string()
      .optional()
      .describe('License terms supplied by the station data provider. Absent when unspecified.'),
    isOpenDataLicensed: z
      .boolean()
      .optional()
      .describe('Whether the provider marks its data as openly licensed. Absent when unknown.'),
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
      .describe(
        'Distance from the search point: the center of a radius search or of a bounding box. Absent along a route, which reports routeDistance and offRouteDistance instead.',
      ),
    routeDistance: z
      .number()
      .optional()
      .describe(
        "Route searches only: distance along the route from its first point to the station's nearest point on the route — the order a driver meets stations.",
      ),
    offRouteDistance: z
      .number()
      .optional()
      .describe(
        'Route searches only: distance from the station to its nearest point on the route — the detour off it. At most the requested distance.',
      ),
    distanceUnit: z
      .enum(['KM', 'Miles'])
      .optional()
      .describe('Unit of distance, routeDistance, and offRouteDistance.'),
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
    usageTypeId: z
      .number()
      .optional()
      .describe(
        'Usage type ID — the value the openchargemap_find_stations usagetypeid filter takes. 0 is OCM\'s "(Unknown)" type. Absent when OCM has no usage type on record.',
      ),
    usageCost: z
      .string()
      .optional()
      .describe(
        'Free-text cost description as recorded (e.g. "£0.30/kWh"). Often absent — absence means unknown, not free.',
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
    dataProviderId: z
      .number()
      .optional()
      .describe(
        'OCM data provider ID. Provider titles are not unique — two providers can share one with different license terms — so the ID is what identifies the provider.',
      ),
  })
  .describe('A charging station record.');

/** Station type inferred from {@link StationSchema} — the shape `format()` receives post-parse. */
export type Station = z.infer<typeof StationSchema>;

/**
 * The full station record: the shared station shape plus the fields only the single-station lookup
 * returns. Shared by openchargemap_get_station and the station resource, which serve the same record
 * from the same normalizer.
 */
export const DetailStationSchema = StationSchema.extend({
  generalComments: z
    .string()
    .optional()
    .describe('Operator/free-text notes about the station. Absent when none on record.'),
  contactPhone: z
    .string()
    .optional()
    .describe(
      'Site contact phone, free text as recorded. Absent when none on record or when the station is a private residence.',
    ),
  contactPhoneSecondary: z
    .string()
    .optional()
    .describe(
      'Second site contact, free text as recorded (occasionally an email address). Absent when none on record or when the station is a private residence.',
    ),
  relatedUrl: z
    .string()
    .optional()
    .describe(
      'Web page for the site (network or venue page). Absent when none on record or when the station is a private residence.',
    ),
  operatorWebsite: z
    .string()
    .optional()
    .describe(
      "Operator network's website. Absent when none on record or when the station is a private residence.",
    ),
  operatorPhone: z
    .string()
    .optional()
    .describe(
      "Operator network's primary contact phone. Absent when none on record or when the station is a private residence.",
    ),
  operatorFaultReportEmail: z
    .string()
    .optional()
    .describe(
      "Operator network's address for reporting a faulty charger. Absent when none on record or when the station is a private residence.",
    ),
  dateCreated: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp the listing was added to Open Charge Map.'),
  dataProviderUrl: z.string().optional().describe('Source provider website.'),
  dateLastStatusUpdate: z
    .string()
    .nullable()
    .optional()
    .describe('ISO 8601 timestamp of the last status update.'),
  submissionStatus: z
    .string()
    .optional()
    .describe('OCM submission/publication status (e.g. "Imported and Published").'),
  media: z
    .array(
      z
        .object({
          url: z.string().describe('Image URL.'),
          comment: z.string().optional().describe('Caption / comment.'),
        })
        .describe('A user-submitted photo.'),
    )
    .optional()
    .describe('User-submitted photos of the station. Absent when none.'),
  comments: z
    .array(CommentSchema)
    .optional()
    .describe(
      'Community check-ins, present only when includeComments=true. Empty array means none on record.',
    ),
}).describe('A full station record, including detail-only fields.');

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
  const parts: string[] = [escapeMarkdownInline(c.connectionType ?? 'Unknown connector')];
  if (c.connectionTypeId != null) parts.push(`typeId ${c.connectionTypeId}`);
  if (c.level) parts.push(escapeMarkdownInline(c.level));
  if (c.levelId != null) parts.push(`levelId ${c.levelId}`);
  if (c.powerKW != null) parts.push(`${c.powerKW} kW`);
  if (c.currentType) parts.push(escapeMarkdownInline(c.currentType));
  if (c.amps != null) parts.push(`${c.amps}A`);
  if (c.voltage != null) parts.push(`${c.voltage}V`);
  if (c.statusTypeId !== undefined || c.status !== undefined || c.isOperational !== undefined) {
    parts.push(
      `Status: ${escapeMarkdownInline(c.status ?? 'Unknown')}${c.statusTypeId !== undefined ? ` (status id ${c.statusTypeId})` : ''} — ${renderOperationalText(c.statusTypeId, c.isOperational)}`,
    );
  }
  if (c.notes) parts.push(`Notes: ${escapeMarkdownInline(c.notes)}`);
  const head = parts.join(' · ');
  return c.quantity != null ? `${head} ×${c.quantity}` : head;
}

/**
 * `Title (id N)`, `Title`, or `id N` — whichever parts OCM gave, so an ID still renders when its
 * title is missing. Undefined when it gave neither.
 */
function titledId(title: string | undefined, id: number | undefined): string | undefined {
  const idText = id === undefined ? undefined : `id ${id}`;
  if (!title) return idText;
  return idText ? `${escapeMarkdownInline(title)} (${idText})` : escapeMarkdownInline(title);
}

/** The provider's license line; `unspecified` when the provider gave no terms. */
function renderProviderLicense(s: Station): string {
  return `Provider license: ${s.dataProviderLicense ? escapeMarkdownInline(s.dataProviderLicense) : 'unspecified'}`;
}

/**
 * Render one station as a markdown block. `providerTerms: 'page'` leaves the provider's license and
 * open-data flag to the page-level block {@link renderStationPage} appends; the detail tool keeps
 * them inline.
 */
export function renderStationBlock(
  s: Station,
  providerTerms: 'inline' | 'page' = 'inline',
): string {
  const lines: string[] = [];
  const unit = s.distanceUnit ?? 'KM';
  const dist = s.distance != null ? ` — ${s.distance.toFixed(2)} ${unit}` : '';
  lines.push(
    `**${escapeMarkdownInline(s.title)}**${dist}  _(id ${s.id}, uuid ${escapeMarkdownInline(s.uuid)})_`,
  );
  // A route search's two positions arrive together, already rounded to hundredths.
  if (s.routeDistance != null)
    lines.push(`Route: ${s.routeDistance} ${unit} along, ${s.offRouteDistance} ${unit} off it`);

  const addrBits = [
    s.address.line1,
    s.address.line2,
    s.address.town,
    s.address.stateOrProvince,
    s.address.postcode,
    s.address.country,
    s.address.countryCode ? `(${s.address.countryCode})` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  if (addrBits) lines.push(escapeMarkdownInline(addrBits));
  lines.push(`Coordinates: ${s.address.latitude}, ${s.address.longitude}`);
  if (s.address.accessComments)
    lines.push(`Access: ${escapeMarkdownInline(s.address.accessComments)}`);

  const opUsage: string[] = [];
  const operator = titledId(s.operator, s.operatorId);
  if (operator) opUsage.push(`Operator: ${operator}`);
  const usage = titledId(s.usageType, s.usageTypeId);
  if (usage) opUsage.push(`Usage: ${usage}`);
  const accessFlags = [
    renderFlag(s.isPayAtLocation, 'pay at location'),
    renderFlag(s.isMembershipRequired, 'membership required'),
    renderFlag(s.isAccessKeyRequired, 'access key required'),
  ].filter(Boolean);
  if (accessFlags.length) opUsage.push(accessFlags.join(', '));
  if (opUsage.length) lines.push(opUsage.join(' · '));
  if (s.usageCost) lines.push(`Usage cost: ${escapeMarkdownInline(s.usageCost)}`);

  if (s.numberOfPoints != null) lines.push(`Charge points: ${s.numberOfPoints}`);
  const provider = titledId(s.dataProvider, s.dataProviderId);
  if (provider) lines.push(`Data provider: ${provider}`);
  if (providerTerms === 'inline') {
    lines.push(renderProviderLicense(s));
    const openLicense = renderFlag(s.isOpenDataLicensed, 'open data licensed');
    if (openLicense) lines.push(openLicense);
  }

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
 * Render a page of search results as blocks: each station, then one `Data providers` entry per
 * provider ID carrying its license and open-data flag, so terms every row shares appear once rather
 * than once per station. The key is the ID because provider titles are not unique. A station with no
 * provider ID, or whose terms differ from the entry already listed under its ID, keeps its terms
 * inline — no station's license is left out of the text.
 */
export function renderStationPage(stations: readonly Station[]): string[] {
  const listed = new Map<number, Station>();
  const blocks: string[] = [];
  for (const s of stations) {
    const id = s.dataProviderId;
    if (id === undefined) {
      blocks.push(renderStationBlock(s));
      continue;
    }
    const entry = listed.get(id) ?? s;
    listed.set(id, entry);
    const sharesEntry =
      entry.dataProviderLicense === s.dataProviderLicense &&
      entry.isOpenDataLicensed === s.isOpenDataLicensed;
    blocks.push(renderStationBlock(s, sharesEntry ? 'page' : 'inline'));
  }
  if (listed.size === 0) return blocks;

  const entries = [...listed].map(([id, s]) => {
    const openLicense = renderFlag(s.isOpenDataLicensed, 'open data licensed');
    return `  - ${titledId(s.dataProvider, id)}${openLicense ? ` · ${openLicense}` : ''} · ${renderProviderLicense(s)}`;
  });
  return [...blocks, ['Data providers:', ...entries].join('\n')];
}

/**
 * Status line with explicit reliability caveat. Render dateLastVerified raw (no slice) so
 * format-parity sees the full value; the recency flag rides alongside.
 */
function renderStatusLine(s: Station): string {
  const id = s.statusTypeId != null ? ` (status id ${s.statusTypeId})` : '';
  const verified = s.dateLastVerified
    ? `last verified ${escapeMarkdownInline(s.dateLastVerified)}`
    : 'never verified';
  const recency = renderFlag(s.isRecentlyVerified, 'recently verified');
  const recencyText = recency ? ` (${recency})` : '';
  return `Status: ${escapeMarkdownInline(s.status ?? 'Unknown')}${id} — ${renderOperationalText(s.statusTypeId, s.isOperational)} · ${verified}${recencyText}`;
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

/** Render one comment line, covering every comment field. */
export function renderComment(c: Comment): string {
  const date = c.dateCreated ? `[${escapeMarkdownInline(c.dateCreated)}] ` : '';
  const user = escapeMarkdownInline(c.user ?? 'anonymous');
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
  const tag = meta ? ` (${escapeMarkdownInline(meta)})` : '';
  // Only open the colon when something follows it, or a check-in whose whole meaning is the
  // outcome renders as a line ending in a dangling separator. Commenters routinely paste the
  // same link inline AND into relatedUrl, so append it only when the text does not already
  // carry it — otherwise the rendered line ends in the URL twice.
  const text = c.comment?.trim();
  const link = c.relatedUrl && !text?.includes(c.relatedUrl) ? c.relatedUrl : undefined;
  const body = [
    text ? escapeMarkdownInline(text) : undefined,
    link ? markdownLink(link, link) : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return `${date}${user}${tag}${body ? `: ${body}` : ''}`;
}
