/**
 * @fileoverview openchargemap_find_stations — find EV charging stations from the global Open
 * Charge Map registry near a point or within a bounding box, with connector/power/network/usage/
 * status filters. Coordinate-native; place names geocode via openstreetmap_geocode first.
 * @module mcp-server/tools/definitions/find-stations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION } from '@/services/openchargemap/attribution.js';
import {
  getOpenChargeMapService,
  MAX_SEARCH_WINDOW,
} from '@/services/openchargemap/openchargemap-service.js';
import type { SearchPoiParams } from '@/services/openchargemap/types.js';
import { renderStationBlock, StationSchema } from './_station-schema.js';

/**
 * Connector/operator/usage/level/status filter: a single positive int ID or an array (OR-matched).
 * The array must be non-empty — an empty one carries no filter and would widen the search instead
 * of narrowing it, so omitting the field is the only way to express "no filter".
 */
const idFilter = (max: number) =>
  z.union([
    z.number().int().positive().describe('A single reference ID.'),
    z
      .array(z.number().int().positive().describe('A reference ID.'))
      .min(1)
      .max(max)
      .describe('Several reference IDs, OR-matched. At least one.'),
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
      'Bounding-box search as an alternative to a center+radius. Mutually exclusive with latitude/longitude/distance — sending a boundingbox alongside a latitude or a longitude is rejected, not resolved in favour of one of them.',
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
    .describe('Maximum stations to return, ordered by distance from the search point. Max 200.'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_SEARCH_WINDOW - 1)
    .default(0)
    .describe(
      `Matching stations to skip before the returned page, for reading past a truncated result. Repeat the same search with the nextOffset value the previous call reported. One search reaches at most ${MAX_SEARCH_WINDOW} stations, so ${MAX_SEARCH_WINDOW - 1} is the deepest offset that can return one — narrow the area or add filters to reach stations beyond that. Ordering is by distance and stable, but Open Charge Map is edited continuously, so a station added or removed between pages can shift what a later offset lands on.`,
    ),
});

export const findStations = tool('openchargemap_find_stations', {
  title: 'openchargemap-mcp-server: find stations',
  description:
    'Find EV charging stations from the global Open Charge Map registry near a point or within a bounding box. Provide either a center (latitude + longitude + distance) or a boundingbox; optionally scope to a country with countrycode. This tool is coordinate-native and does not geocode place names — resolve a place like "Ballard, Seattle" to coordinates with openstreetmap_geocode first, then pass them here. Filter by connector type, minimum power (kW), operator/network, usage type (public/free/membership), charge level, operational status, and minimum charge points. Filter IDs are integers — resolve a connector or network name to its ID with openchargemap_lookup_reference (e.g. "CCS" -> 33). Each result includes title, address, distance from the search point, connections (type, power, count), operator, access rules, registry operational status, and the last-verified date. Results come back one page at a time: when a page reports truncated, repeat the same search with the reported nextOffset to read the next one.',
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
    totalCount: z
      .number()
      .describe(
        'Matching stations this search retrieved, before the offset/maxresults page was taken. Open Charge Map publishes no match total and one search can only retrieve so deep, so this is exact only when the search reached the end of what Open Charge Map holds for the area — otherwise it is a floor that rises as deeper pages are read. The notice says which of the two applies.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when matching stations were left out of the returned page.'),
    shown: z.number().optional().describe('Stations in the returned page.'),
    cap: z.number().optional().describe('The maxresults cap that was applied.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'The offset to pass on an otherwise identical call to read the next page. Absent when nothing further was retrieved.',
      ),
    notice: z
      .string()
      .optional()
      .describe('How to reach the stations this page left out, or why it came back empty.'),
  },

  // `totalCount` counts what this search retrieved, which is the whole match set only when the
  // search reached the end of it. The default `**N total**` rendering reads as a match total in
  // either case, so the trailer names what the number actually counts and leaves whether more
  // exist to the notice beside it.
  enrichmentTrailer: {
    totalCount: {
      render(value) {
        return `**${value} matching stations retrieved**`;
      },
    },
  },

  errors: [
    {
      reason: 'invalid_location',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No search area was provided; or only one half of a center arrived; or a boundingbox arrived alongside a latitude or a longitude.',
      recovery:
        'Provide either latitude + longitude (+ optional distance), or a boundingbox — exactly one, with no leftover coordinate beside the box. Geocode a place name with openstreetmap_geocode to obtain coordinates.',
    },
    {
      reason: 'no_stations',
      code: JsonRpcErrorCode.NotFound,
      when: 'Open Charge Map holds no station for the search area and filters — either it returned nothing at all, or every station it returned was ruled out and there were no further candidates.',
      recovery:
        'Widen the distance/bounding box, relax filters (drop minpowerkw, minchargepoints, or connectiontypeid), or remove countrycode. Verify the coordinates are on land in a covered region.',
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
      when: 'OCM returned HTTP 401 or 403 — the API key is missing or invalid.',
      recovery:
        'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org). This is a server configuration issue, not an input error.',
    },
  ],

  async handler(input, ctx) {
    const hasLatitude = input.latitude !== undefined;
    const hasLongitude = input.longitude !== undefined;
    const hasRadius = hasLatitude && hasLongitude;
    const hasBbox = input.boundingbox !== undefined;
    // A boundingbox rules out EITHER coordinate, not just a complete center. Gating on the complete
    // center let `{ latitude, boundingbox }` through as a bounding-box-only call, and the latitude
    // was then dropped with nothing in the response saying so.
    if (hasBbox ? hasLatitude || hasLongitude : !hasRadius) {
      throw ctx.fail('invalid_location', locationFailure({ hasLatitude, hasLongitude, hasBbox }), {
        ...ctx.recoveryFor('invalid_location'),
      });
    }

    const params: SearchPoiParams = {
      window: input.offset + input.maxresults,
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

    const { candidateCap, fetched, matches } = await getOpenChargeMapService().searchPois(
      params,
      ctx,
    );
    // A full candidate page means the registry holds more than was retrieved, so an empty page is
    // a limit of this search rather than a fact about the area. Only a page that came back short
    // settles the question — and only then can zero matches honestly be reported as none existing.
    const moreUpstream = fetched >= candidateCap;
    ctx.log.info('OCM search complete', {
      fetched,
      matches: matches.length,
      mode: hasBbox ? 'bbox' : 'radius',
    });

    if (matches.length === 0 && !moreUpstream) {
      throw ctx.fail('no_stations', 'No charging stations matched the search and filters.', {
        ...ctx.recoveryFor('no_stations'),
      });
    }

    const stations = matches.slice(input.offset, input.offset + input.maxresults);
    /** One past the last station on this page — both the next offset and the more-left test. */
    const pageEnd = input.offset + stations.length;
    const moreRetrieved = matches.length > pageEnd;

    ctx.enrich.total(matches.length);
    if (moreRetrieved || moreUpstream) {
      ctx.enrich.truncated({
        shown: stations.length,
        cap: input.maxresults,
        guidance: truncationGuidance({
          matched: matches.length,
          moreRetrieved,
          moreUpstream,
          offset: input.offset,
          pageSize: stations.length,
          maxresults: input.maxresults,
        }),
      });
      if (moreRetrieved) ctx.enrich({ nextOffset: pageEnd });
    } else if (stations.length === 0) {
      ctx.enrich.notice(
        `This search matched ${matches.length} station(s), so offset ${input.offset} is past the end. Lower offset to read them.`,
      );
    }

    return {
      stations,
      searchSummary: buildSearchSummary(input, hasBbox),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    // "Showing", not "Found" — this is one page, and the match count rides the enrichment trailer.
    const lines = [`Showing ${result.stations.length} station(s). ${result.searchSummary}`, ''];
    for (const s of result.stations) {
      lines.push(renderStationBlock(s), '');
    }
    lines.push(result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Name the specific location problem the caller hit. Every message states what actually arrived: a
 * bounding box present here means at least one coordinate came with it, and its absence means at
 * most one of latitude/longitude arrived. A confidently-worded wrong diagnosis costs the caller
 * more than a vague one, so the lone-coordinate cases name the coordinate they got rather than
 * borrowing the full-center wording.
 */
function locationFailure(supplied: {
  hasLatitude: boolean;
  hasLongitude: boolean;
  hasBbox: boolean;
}): string {
  if (supplied.hasBbox) {
    if (supplied.hasLatitude && supplied.hasLongitude) {
      return 'Both a center (latitude + longitude) and a boundingbox were supplied — provide exactly one, not both.';
    }
    const coordinate = supplied.hasLatitude ? 'latitude' : 'longitude';
    return `A ${coordinate} and a boundingbox were supplied, and a ${coordinate} on its own is not a center — provide either a center (latitude + longitude) or a boundingbox, not both.`;
  }
  if (supplied.hasLatitude) {
    return 'Longitude is missing — a center search needs latitude and longitude together.';
  }
  if (supplied.hasLongitude) {
    return 'Latitude is missing — a center search needs latitude and longitude together.';
  }
  return 'No search area was provided — supply either a center (latitude + longitude) or a boundingbox.';
}

/**
 * Say what the page left out and how to reach it. Two things can be missing at once — matches this
 * page skipped, and stations the search never retrieved — so the offset advice and the narrow-the-
 * search advice compose into one notice rather than one overwriting the other.
 *
 * `moreUpstream` decides what the notice is allowed to claim, and it is the whole reason this takes
 * two flags rather than one. A candidate page that came back short retrieved everything Open Charge
 * Map holds for the area, so `matched` IS the match count and there is nothing deeper to widen
 * toward — telling that caller to narrow the area would be both false and the opposite of what
 * recovers their data (paging does). A full page leaves `matched` a floor, so no sentence may state
 * it as the number of matching stations.
 */
function truncationGuidance(page: {
  matched: number;
  maxresults: number;
  moreRetrieved: boolean;
  moreUpstream: boolean;
  offset: number;
  pageSize: number;
}): string {
  const total = page.moreUpstream
    ? `${page.matched} stations retrieved`
    : `${page.matched} matching stations`;
  const holdsMore =
    'Open Charge Map holds more stations than this search retrieved — narrow the area or add filters to reach them.';
  const deeper = page.moreUpstream ? ` ${holdsMore}` : '';
  /** Only a sentence that names the count may call it a floor; the zero-match branch names none. */
  const counted = page.moreUpstream ? ` That count is a floor: ${holdsMore}` : '';
  if (page.moreRetrieved) {
    return `Showing ${page.pageSize} of ${total}, from offset ${page.offset}. Pass offset ${page.offset + page.pageSize} on the same search for the next ${page.maxresults}.${counted}`;
  }
  if (page.matched === 0) {
    return `No station this search retrieved met the filters. Relax minchargepoints or the other filters.${deeper}`;
  }
  if (page.pageSize === 0) {
    return `This search retrieved ${page.matched} station(s), so offset ${page.offset} is past the last one. Lower offset to read them.${counted}`;
  }
  return `Showing ${page.pageSize} of ${total}, from offset ${page.offset} — every station this search retrieved.${counted}`;
}

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
  if (input.offset > 0) bits.push(`offset=${input.offset}`);
  bits.push(`maxresults=${input.maxresults}`);
  return `${bits.join('; ')}.`;
}
