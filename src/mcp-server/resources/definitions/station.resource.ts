/**
 * @fileoverview openchargemap://station/{id} — the resource twin of openchargemap_get_station.
 * Returns the full station record (with community comments) by numeric OCM ID; convenience for
 * clients that support injectable context by stable URI. Fully covered by the tool surface.
 * @module mcp-server/resources/definitions/station.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DetailStationSchema } from '@/mcp-server/tools/definitions/_station-schema.js';
import { ATTRIBUTION, buildReliabilityNote } from '@/services/openchargemap/attribution.js';
import { getOpenChargeMapService } from '@/services/openchargemap/openchargemap-service.js';

export const stationResource = resource('openchargemap://station/{id}', {
  name: 'openchargemap-station',
  title: 'openchargemap-mcp-server: station record',
  description:
    'Full Open Charge Map station record by numeric OCM ID, including community comments.',
  mimeType: 'application/json',
  // The service caches a station record for 600s, so a client holding one for the same window
  // never sees anything staler than a second read would return.
  cacheHint: { ttlMs: 600_000 },
  params: z.object({
    id: z.string().regex(/^\d+$/).describe('Numeric OCM station ID.'),
  }),

  output: z.object({
    station: DetailStationSchema.describe('The full station record, with community comments.'),
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
  ],

  async handler(params, ctx) {
    const id = Number(params.id);
    const station = await getOpenChargeMapService().getPoi(id, { includeComments: true }, ctx);
    if (!station) {
      throw ctx.fail('not_found', `No Open Charge Map station with ID ${id}.`, {
        ...ctx.recoveryFor('not_found'),
      });
    }
    const reliabilityNote = buildReliabilityNote({
      status: station.status,
      statusTypeId: station.statusTypeId,
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
});
