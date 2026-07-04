/**
 * @fileoverview openchargemap://station/{id} — the resource twin of openchargemap_get_station.
 * Returns the full station record (with community comments) by numeric OCM ID; convenience for
 * clients that support injectable context by stable URI. Fully covered by the tool surface.
 * @module mcp-server/resources/definitions/station.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION, buildReliabilityNote } from '@/services/openchargemap/attribution.js';
import { getOpenChargeMapService } from '@/services/openchargemap/openchargemap-service.js';

export const stationResource = resource('openchargemap://station/{id}', {
  name: 'openchargemap-station',
  title: 'openchargemap-mcp-server: station record',
  description:
    'Full Open Charge Map station record by numeric OCM ID, including community comments.',
  mimeType: 'application/json',
  params: z.object({
    id: z.string().regex(/^\d+$/).describe('Numeric OCM station ID.'),
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
