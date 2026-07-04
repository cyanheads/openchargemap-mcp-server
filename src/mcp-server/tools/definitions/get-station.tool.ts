/**
 * @fileoverview openchargemap_get_station — full record for one Open Charge Map station by numeric
 * OCM ID (verbose=true), with optional inline community comments and a computed reliability note.
 * @module mcp-server/tools/definitions/get-station.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION, buildReliabilityNote } from '@/services/openchargemap/attribution.js';
import { getOpenChargeMapService } from '@/services/openchargemap/openchargemap-service.js';
import { CommentSchema, renderStationBlock, StationSchema } from './_station-schema.js';

/** Detail station = the shared station shape plus detail-only fields. */
const DetailStationSchema = StationSchema.extend({
  generalComments: z
    .string()
    .optional()
    .describe('Operator/free-text notes about the station. Absent when none on record.'),
  usageCost: z
    .string()
    .optional()
    .describe(
      'Free-text cost description (e.g. "£0.30/kWh"). Often absent — absence means unknown, not free.',
    ),
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
});

export const getStation = tool('openchargemap_get_station', {
  title: 'openchargemap-mcp-server: get station',
  description:
    'Get the full record for one Open Charge Map station by its numeric OCM ID. Returns every connection (type, level, power, current, quantity, per-connection status), the operator and network, usage and access restrictions (pay-at-location, membership, access key), the number of charge points, general comments, usage cost, the data provider, media, and verification recency. Set includeComments to also return community check-ins inline.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z.number().int().positive().describe('Numeric OCM station ID (e.g. 145452).'),
    includeComments: z
      .boolean()
      .default(false)
      .describe(
        'Include community check-ins and comments inline in the response. Adds payload but gives the real-world reliability signal alongside the registry status. For comments alone, use openchargemap_get_station_comments.',
      ),
  }),

  output: z.object({
    station: DetailStationSchema.describe('The full station record.'),
    reliabilityNote: z
      .string()
      .optional()
      .describe(
        'A caveat when the registry status, verification age, coordinates, or comments suggest the listing may not reflect reality. Omitted when there is nothing to flag.',
      ),
    attribution: z
      .string()
      .describe('Required CC BY 4.0 attribution to Open Charge Map contributors.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'OCM returned an empty result for the given numeric ID (HTTP 200 with []) — no such station.',
      recovery:
        'Verify the numeric OCM ID. Find a valid station first with openchargemap_find_stations.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'OCM returned a non-2xx response or timed out.',
      recovery: 'Retry after a short delay. If it persists, OCM may be rate-limiting or down.',
    },
    {
      reason: 'auth_failed',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OCM returned HTTP 403 — the API key is missing or invalid.',
      recovery:
        'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org). This is a server configuration issue, not an input error.',
    },
  ],

  async handler(input, ctx) {
    const station = await getOpenChargeMapService().getPoi(
      input.id,
      { includeComments: input.includeComments },
      ctx,
    );
    if (!station) {
      throw ctx.fail('not_found', `No Open Charge Map station with ID ${input.id}.`, {
        ...ctx.recoveryFor('not_found'),
      });
    }
    ctx.log.info('OCM detail fetched', { id: input.id, connections: station.connections.length });

    const reliabilityNote = buildReliabilityNote({
      status: station.status,
      isOperational: station.isOperational,
      dateLastVerified: station.dateLastVerified,
      comments: station.comments,
      coordinates: { latitude: station.address.latitude, longitude: station.address.longitude },
    });

    return {
      station,
      ...(reliabilityNote ? { reliabilityNote } : {}),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const s = result.station;
    const lines = [renderStationBlock(s)];

    if (s.generalComments) lines.push(`General comments: ${s.generalComments}`);
    if (s.usageCost) lines.push(`Usage cost: ${s.usageCost}`);
    if (s.dataProviderUrl) lines.push(`Data provider URL: ${s.dataProviderUrl}`);
    if (s.dateLastStatusUpdate) lines.push(`Last status update: ${s.dateLastStatusUpdate}`);
    if (s.submissionStatus) lines.push(`Submission status: ${s.submissionStatus}`);

    if (s.media && s.media.length > 0) {
      lines.push('Media:');
      for (const m of s.media) lines.push(`  - ${m.url}${m.comment ? ` (${m.comment})` : ''}`);
    }

    if (s.comments) {
      if (s.comments.length === 0) {
        lines.push('Comments: none on record');
      } else {
        lines.push('Comments:');
        for (const c of s.comments) lines.push(`  - ${renderComment(c)}`);
      }
    }

    if (result.reliabilityNote) lines.push('', `⚠️ Reliability: ${result.reliabilityNote}`);
    lines.push('', result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Render one comment line; shared shape with get_station_comments. */
export function renderComment(c: z.infer<typeof CommentSchema>): string {
  const date = c.dateCreated ? `[${c.dateCreated}] ` : '';
  const user = c.user ?? 'anonymous';
  const meta = [c.commentType, c.rating != null ? `★${c.rating}` : undefined]
    .filter(Boolean)
    .join(', ');
  const tag = meta ? ` (${meta})` : '';
  return `${date}${user}${tag}: ${c.comment ?? ''}`.trim();
}
