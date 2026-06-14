/**
 * @fileoverview openchargemap_find_stations — find EV charging stations from the global Open
 * Charge Map registry near a point or within a bounding box, with connector/power/network/usage/
 * status filters. Coordinate-native; place names geocode via openstreetmap_geocode first.
 * @module mcp-server/tools/definitions/find-stations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION } from '@/services/openchargemap/attribution.js';
import { getOpenChargeMapService } from '@/services/openchargemap/openchargemap-service.js';
import type { SearchPoiParams } from '@/services/openchargemap/types.js';
import { renderStationBlock, StationSchema } from './_station-schema.js';

/** Connector/operator/usage/level/status filter: a single positive int ID or an array (OR-matched). */
const idFilter = (max: number) =>
  z.union([
    z.number().int().positive().describe('A single reference ID.'),
    z
      .array(z.number().int().positive().describe('A reference ID.'))
      .max(max)
      .describe('Several reference IDs, OR-matched.'),
  ]);

/** Input schema, extracted so the search-summary helper can reference its inferred type. */
const FindStationsInput = z.object({
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe(
      'Center latitude (WGS84 decimal degrees). Use with longitude + distance for a radius search. Resolve place names via openstreetmap_geocode first.',
    ),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe(
      'Center longitude (WGS84 decimal degrees). Use with latitude + distance for a radius search.',
    ),
  distance: z
    .number()
    .positive()
    .max(500)
    .default(25)
    .describe(
      'Search radius from the center point, in the unit given by distanceUnit (default km). Max 500. Keep small (5-25) for dense urban areas; widen for rural coverage.',
    ),
  distanceUnit: z
    .enum(['KM', 'Miles'])
    .default('KM')
    .describe('Unit for the distance parameter and the returned distance values.'),
  boundingbox: z
    .object({
      sw_lat: z.number().min(-90).max(90).describe('South-west corner latitude.'),
      sw_lng: z.number().min(-180).max(180).describe('South-west corner longitude.'),
      ne_lat: z.number().min(-90).max(90).describe('North-east corner latitude.'),
      ne_lng: z.number().min(-180).max(180).describe('North-east corner longitude.'),
    })
    .optional()
    .describe(
      'Bounding-box search as an alternative to a center+radius. Mutually exclusive with latitude/longitude/distance.',
    ),

  countrycode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe(
      'Restrict to one country by ISO 3166-1 alpha-2 code (e.g. "US", "FR", "GB"). Omit for a global search. The server is global by default — there is no implicit country.',
    ),
  connectiontypeid: idFilter(10)
    .optional()
    .describe(
      'Connector type ID, or an array of IDs (OR-matched). Resolve names with openchargemap_lookup_reference — e.g. CCS (Type 2)=33, CHAdeMO=2, NACS/Tesla Supercharger=27, Type 2 socket=25, Type 1/J1772=1.',
    ),
  minpowerkw: z
    .number()
    .positive()
    .max(1000)
    .optional()
    .describe(
      'Minimum charging power in kW across any connection at the station. Use ~50 for DC fast charging, ~150 for high-power DC. Stations whose fastest connection is below this are excluded.',
    ),
  operatorid: idFilter(10)
    .optional()
    .describe(
      'Operator/network ID, or array of IDs (OR-matched). Resolve a network name with openchargemap_lookup_reference (category "operators") — e.g. "Tesla", "ChargePoint".',
    ),
  usagetypeid: idFilter(10)
    .optional()
    .describe(
      'Usage/access type ID, or array (OR-matched). Resolve via openchargemap_lookup_reference (category "usagetypes") — e.g. Public=1, Public-Pay At Location=5, Public-Membership Required=4.',
    ),
  levelid: idFilter(3)
    .optional()
    .describe(
      'Charge level ID (1=Low <2kW, 2=Medium >2kW, 3=High >40kW/fast). Array OR-matched. Use 3 as a coarse "fast charging only" filter when a specific connector is not required.',
    ),
  statustypeid: idFilter(10)
    .optional()
    .describe(
      'Registry operational-status ID, or array (OR-matched). Resolve via openchargemap_lookup_reference (category "statustypes"). NOTE: registry status is operator-reported and can be stale — combine with dateLastVerified and openchargemap_get_station_comments to judge real-world reliability, do not treat it as ground truth.',
    ),
  minchargepoints: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Minimum number of charge points (stalls) at the station. Filters out single-point locations when you need a station likely to have an open stall.',
    ),

  maxresults: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(25)
    .describe(
      'Maximum stations to return, ordered by distance from the search point. Max 200. Larger values cost more payload and upstream load — prefer tightening filters over raising this.',
    ),
});

export const findStations = tool('openchargemap_find_stations', {
  title: 'openchargemap-mcp-server: find stations',
  description:
    'Find EV charging stations from the global Open Charge Map registry near a point or within a bounding box. Provide either a center (latitude + longitude + distance) or a boundingbox; optionally scope to a country with countrycode. This tool is coordinate-native and does not geocode place names — resolve a place like "Ballard, Seattle" to coordinates with openstreetmap_geocode first, then pass them here. Filter by connector type, minimum power (kW), operator/network, usage type (public/free/membership), charge level, operational status, and minimum charge points. Filter IDs are integers — resolve a connector or network name to its ID with openchargemap_lookup_reference (e.g. "CCS" -> 33). Each result includes title, address, distance from the search point, connections (type, power, count), operator, access rules, registry operational status, and the last-verified date — treat an old dateLastVerified or a non-operational status as a reliability caveat.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: FindStationsInput,

  output: z.object({
    stations: z
      .array(StationSchema)
      .describe('Matching stations, ordered by distance from the search point.'),
    searchSummary: z
      .string()
      .describe(
        'Human-readable echo of the resolved search: location mode, scope, and active filters as the server applied them.',
      ),
    attribution: z
      .string()
      .describe('Required attribution to Open Charge Map contributors under CC BY 4.0.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Number of stations returned.'),
    truncated: z.boolean().optional().describe('True when results were capped at maxresults.'),
    shown: z.number().optional().describe('Number of stations returned when the cap was hit.'),
    cap: z.number().optional().describe('The maxresults cap that was applied.'),
  },

  errors: [
    {
      reason: 'invalid_location',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither a center (latitude+longitude) nor a boundingbox was provided, or both were.',
      recovery:
        'Provide either latitude + longitude (+ optional distance), or a boundingbox — exactly one. Geocode a place name with openstreetmap_geocode to obtain coordinates.',
    },
    {
      reason: 'no_stations',
      code: JsonRpcErrorCode.NotFound,
      when: 'The search and filters returned zero stations.',
      recovery:
        'Widen the distance/bounding box, relax filters (drop minpowerkw or connectiontypeid), or remove countrycode. Verify the coordinates are on land in a covered region.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'OCM returned a non-2xx response or timed out.',
      recovery:
        'Retry after a short delay. If it persists, OCM may be rate-limiting or down — reduce call frequency.',
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
    const hasRadius = input.latitude !== undefined && input.longitude !== undefined;
    const hasBbox = input.boundingbox !== undefined;
    if (hasRadius === hasBbox) {
      throw ctx.fail('invalid_location', undefined, { ...ctx.recoveryFor('invalid_location') });
    }

    const params: SearchPoiParams = {
      maxresults: input.maxresults,
      ...(input.boundingbox
        ? { boundingbox: input.boundingbox }
        : {
            latitude: input.latitude,
            longitude: input.longitude,
            distance: input.distance,
            distanceUnit: input.distanceUnit,
          }),
      ...(input.countrycode ? { countrycode: input.countrycode } : {}),
      ...(input.connectiontypeid !== undefined ? { connectiontypeid: input.connectiontypeid } : {}),
      ...(input.minpowerkw !== undefined ? { minpowerkw: input.minpowerkw } : {}),
      ...(input.operatorid !== undefined ? { operatorid: input.operatorid } : {}),
      ...(input.usagetypeid !== undefined ? { usagetypeid: input.usagetypeid } : {}),
      ...(input.levelid !== undefined ? { levelid: input.levelid } : {}),
      ...(input.statustypeid !== undefined ? { statustypeid: input.statustypeid } : {}),
      ...(input.minchargepoints !== undefined ? { minchargepoints: input.minchargepoints } : {}),
    };

    const stations = await getOpenChargeMapService().searchPois(params, ctx);
    ctx.log.info('OCM search complete', {
      count: stations.length,
      mode: hasBbox ? 'bbox' : 'radius',
    });

    if (stations.length === 0) {
      throw ctx.fail('no_stations', 'No charging stations matched the search and filters.', {
        ...ctx.recoveryFor('no_stations'),
      });
    }

    ctx.enrich.total(stations.length);
    if (stations.length >= input.maxresults) {
      ctx.enrich.truncated({ shown: stations.length, cap: input.maxresults });
    }

    return {
      stations,
      searchSummary: buildSearchSummary(input, hasBbox),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines = [`Found ${result.stations.length} station(s). ${result.searchSummary}`, ''];
    for (const s of result.stations) {
      lines.push(renderStationBlock(s), '');
    }
    lines.push(result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Compose a human-readable echo of the resolved search and active filters. */
function buildSearchSummary(input: z.infer<typeof FindStationsInput>, hasBbox: boolean): string {
  const bits: string[] = [];
  if (hasBbox && input.boundingbox) {
    const b = input.boundingbox;
    bits.push(`Bounding box (${b.sw_lat},${b.sw_lng})-(${b.ne_lat},${b.ne_lng})`);
  } else {
    bits.push(
      `Within ${input.distance} ${input.distanceUnit} of ${input.latitude},${input.longitude}`,
    );
  }
  if (input.countrycode) bits.push(`country=${input.countrycode.toUpperCase()}`);
  if (input.connectiontypeid !== undefined)
    bits.push(`connectiontypeid=${[input.connectiontypeid].flat().join(',')}`);
  if (input.minpowerkw !== undefined) bits.push(`minpowerkw=${input.minpowerkw}`);
  if (input.operatorid !== undefined)
    bits.push(`operatorid=${[input.operatorid].flat().join(',')}`);
  if (input.usagetypeid !== undefined)
    bits.push(`usagetypeid=${[input.usagetypeid].flat().join(',')}`);
  if (input.levelid !== undefined) bits.push(`levelid=${[input.levelid].flat().join(',')}`);
  if (input.statustypeid !== undefined)
    bits.push(`statustypeid=${[input.statustypeid].flat().join(',')}`);
  if (input.minchargepoints !== undefined) bits.push(`minchargepoints=${input.minchargepoints}`);
  bits.push(`maxresults=${input.maxresults}`);
  return `${bits.join('; ')}.`;
}
