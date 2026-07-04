/**
 * @fileoverview openchargemap_get_station_comments — community check-ins for one Open Charge Map
 * station (the honest reliability signal beyond the registry flag). Backed by the POI fetch with
 * includecomments=true (there is no standalone /comments endpoint); returns comments alongside the
 * registry status and last-verified date so claim-vs-reports mismatch is visible.
 * @module mcp-server/tools/definitions/get-station-comments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION, buildReliabilityNote } from '@/services/openchargemap/attribution.js';
import { getOpenChargeMapService } from '@/services/openchargemap/openchargemap-service.js';
import { CommentSchema } from './_station-schema.js';
import { renderComment } from './get-station.tool.js';

export const getStationComments = tool('openchargemap_get_station_comments', {
  title: 'openchargemap-mcp-server: get station comments',
  description:
    'Read community check-ins and comments for one Open Charge Map station — the real-world reliability signal beyond the operator-reported registry status. Returns user comments and fault reports with ratings and dates, alongside the station\'s current registry status and last-verified date, surfacing mismatches like "listed operational, but the last few check-ins report a fault."',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z.number().int().positive().describe('Numeric OCM station ID.'),
    maxresults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum comments to return, newest first. Max 100.'),
  }),

  output: z.object({
    stationId: z.number().describe('OCM station ID the comments belong to.'),
    stationTitle: z.string().describe('Station name, for context.'),
    registryStatus: z
      .string()
      .optional()
      .describe('Current registry operational status (operator-reported).'),
    isOperational: z
      .boolean()
      .optional()
      .describe(
        'Whether the registry marks the station operational. Absent when the operational state is unknown. Compare against the comments below — they are the real-world check.',
      ),
    dateLastVerified: z
      .string()
      .nullable()
      .optional()
      .describe('ISO 8601 date the listing was last verified. null when never verified.'),
    comments: z
      .array(CommentSchema)
      .describe(
        'Community comments, newest first. Empty array means OCM has no check-ins for this station — absence of reports is not evidence the charger works.',
      ),
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

  enrichment: {
    totalCount: z.number().describe('Number of comments returned.'),
    truncated: z.boolean().optional().describe('True when comments were capped at maxresults.'),
    shown: z.number().optional().describe('Number of comments returned when the cap was hit.'),
    cap: z.number().optional().describe('The maxresults cap that was applied.'),
    notice: z.string().optional().describe('Guidance when the station has no check-ins on record.'),
  },

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
      { includeComments: true },
      ctx,
    );
    if (!station) {
      throw ctx.fail('not_found', `No Open Charge Map station with ID ${input.id}.`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    const allComments = station.comments ?? [];
    const comments = allComments.slice(0, input.maxresults);
    ctx.log.info('OCM comments fetched', {
      id: input.id,
      total: allComments.length,
      shown: comments.length,
    });

    ctx.enrich.total(comments.length);
    if (allComments.length > input.maxresults) {
      ctx.enrich.truncated({
        shown: comments.length,
        cap: input.maxresults,
        guidance: `Showing ${comments.length} of ${allComments.length} comments (newest first). Raise maxresults (max 100) for more.`,
      });
    } else if (comments.length === 0) {
      ctx.enrich.notice(
        'No community check-ins on record for this station. Absence of reports is not evidence the charger works.',
      );
    }

    const reliabilityNote = buildReliabilityNote({
      status: station.status,
      isOperational: station.isOperational,
      dateLastVerified: station.dateLastVerified,
      comments: allComments,
      coordinates: { latitude: station.address.latitude, longitude: station.address.longitude },
    });

    return {
      stationId: station.id,
      stationTitle: station.title,
      ...(station.status ? { registryStatus: station.status } : {}),
      ...(station.isOperational !== undefined ? { isOperational: station.isOperational } : {}),
      ...(station.dateLastVerified !== undefined
        ? { dateLastVerified: station.dateLastVerified }
        : {}),
      comments,
      ...(reliabilityNote ? { reliabilityNote } : {}),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const opText =
      result.isOperational === true
        ? 'operational'
        : result.isOperational === false
          ? 'NOT operational'
          : 'operational state unknown';
    const verified = result.dateLastVerified
      ? `last verified ${result.dateLastVerified}`
      : 'never verified';
    const lines = [
      `**${result.stationTitle}** (id ${result.stationId})`,
      `Registry status: ${result.registryStatus ?? 'Unknown'} (${opText}) · ${verified}`,
      '',
    ];

    if (result.comments.length === 0) {
      lines.push(
        'No community check-ins on record — absence of reports is not evidence the charger works.',
      );
    } else {
      lines.push(`${result.comments.length} comment(s), newest first:`);
      for (const c of result.comments) lines.push(`- ${renderComment(c)}`);
    }

    if (result.reliabilityNote) lines.push('', `⚠️ Reliability: ${result.reliabilityNote}`);
    lines.push('', result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
