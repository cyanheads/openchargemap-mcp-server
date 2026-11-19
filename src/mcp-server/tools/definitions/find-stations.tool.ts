/**
 * @fileoverview openchargemap_find_stations — find EV charging stations from the global Open
 * Charge Map registry near a point, within a bounding box, or along a route, with connector/power/
 * network/usage/status filters. Coordinate-native; place names geocode via
 * openstreetmap_search_places first.
 * @module mcp-server/tools/definitions/find-stations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION } from '@/services/openchargemap/attribution.js';
import {
  getOpenChargeMapService,
  MAX_SEARCH_WINDOW,
} from '@/services/openchargemap/openchargemap-service.js';
import type { SearchArea, SearchLocation } from '@/services/openchargemap/types.js';
import { getReferenceDataService } from '@/services/reference-data/reference-data-service.js';
import { applyPageLimit, pageLimitSchema } from './_page-limit.js';
import { renderStationPage, StationSchema } from './_station-schema.js';

/**
 * Connector/operator/usage/level/status filter: an integer ID or an array (OR-matched), with the category's minimum.
 * The array must be non-empty — an empty one carries no filter and would widen the search instead
 * of narrowing it, so omitting the field is the only way to express "no filter".
 */
const idFilter = (max: number, min = 1) =>
  z.union([
    z.number().int().min(min).describe('A single reference ID.'),
    z
      .array(z.number().int().min(min).describe('A reference ID.'))
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
      'Center latitude (WGS84 decimal degrees). Use with longitude + distance for a radius search. Resolve place names via openstreetmap_search_places first.',
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
      'Search radius from the center point — or, along a route, the corridor half-width: how far from the route a station may sit — in the unit given by distanceUnit (default km). Max 500. For a radius, keep small (5-25) in dense urban areas and widen for rural coverage; for a driving corridor, 2-10 km is typical.',
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
      'Bounding-box search as an alternative to a center+radius. The box is searched outward from its center, so its stations come back nearest the center first, each with its distance from the center in distanceUnit. The latitude corners may come in either order; a sw_lng greater than ne_lng spans the ±180° meridian (e.g. sw_lng 170, ne_lng -170 is the 20° around it, not the 340° between). Mutually exclusive with latitude/longitude/distance and route — sending a boundingbox alongside a latitude or a longitude is rejected, not resolved in favour of one of them.',
    ),
  route: z
    .array(
      z
        .object({
          latitude: z.number().min(-90).max(90).describe('Point latitude (WGS84 decimal degrees).'),
          longitude: z
            .number()
            .min(-180)
            .max(180)
            .describe('Point longitude (WGS84 decimal degrees).'),
        })
        .describe('One route point.'),
    )
    .min(2)
    .max(500)
    .optional()
    .describe(
      "Search along a route instead of around a point or in a box: its points in travel order, 2 to 500 of them — waypoints, or a routing service's geometry. Each leg runs the shortest way between its two points, and distance becomes the corridor half-width. Stations within it come back in the order a driver meets them, each with routeDistance (along the route from its first point) and offRouteDistance (off the route), in distanceUnit. Mutually exclusive with latitude/longitude and boundingbox. Each leg must span less than 180° of longitude, so a route cannot cross ±180°.",
    ),

  countrycode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe(
      'Restrict to one country by ISO 3166-1 alpha-2 code (e.g. "US", "FR", "GB"). Omit for a global search. An unrecognized code is not applied; the summary and notice disclose the unrestricted search. Resolve valid codes with openchargemap_lookup_reference (countries).',
    ),
  connectiontypeid: idFilter(10, 0)
    .optional()
    .describe(
      'Connector type ID, or an array of IDs (OR-matched). Resolve names with openchargemap_lookup_reference — e.g. CCS is two IDs, 32 (Type 1, North America) and 33 (Type 2, Europe and most other regions), so pass [32, 33] when the region is unknown; CHAdeMO=2, NACS/Tesla Supercharger=27, Type 2 socket=25, Type 1/J1772=1.',
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
  usagetypeid: idFilter(10, 0)
    .optional()
    .describe(
      'Usage/access type ID, or array (OR-matched). Resolve via openchargemap_lookup_reference (category "usagetypes") — e.g. Public=1, Public-Pay At Location=5, Public-Membership Required=4.',
    ),
  levelid: idFilter(3)
    .optional()
    .describe(
      'Charge level ID (1=Low <2kW, 2=Medium >2kW, 3=High >40kW/fast). Array OR-matched. Use 3 as a coarse "fast charging only" filter when a specific connector is not required.',
    ),
  statustypeid: idFilter(10, 0)
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

  maxresults: pageLimitSchema(200)
    .default(25)
    .describe(
      'Maximum stations to return, nearest the search point first — the center of a radius search or of a bounding box — or in route order along a route. Max 200; larger values are clamped to 200.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_SEARCH_WINDOW - 1)
    .default(0)
    .describe(
      `Matching stations to skip before the returned page, for reading past a truncated result. Repeat the same search with the nextOffset value the previous call reported. One search reaches at most ${MAX_SEARCH_WINDOW} stations, so ${MAX_SEARCH_WINDOW - 1} is the deepest offset that can return one — narrow the area or add filters to reach stations beyond that. Ordering is by distance from the search point (a bounding box's center), or along a route by routeDistance then offRouteDistance, with station ID breaking ties, and stable, but Open Charge Map is edited continuously, so a station added or removed between pages can shift what a later offset lands on.`,
    ),
});

export const findStations = tool('openchargemap_find_stations', {
  title: 'openchargemap-mcp-server: find stations',
  description:
    'Find EV charging stations from the global Open Charge Map registry near a point, within a bounding box, or along a route. Provide one location: a center (latitude + longitude + distance), a boundingbox, or a route (its points in travel order, with distance as the corridor half-width); optionally scope to a country with countrycode. This tool is coordinate-native and does not geocode place names — resolve a place like "Ballard, Seattle" to coordinates with openstreetmap_search_places first, then pass them here. Filter by connector type, minimum power (kW), operator/network, usage type (public, membership required, pay at location, private; price is not a usage type), charge level, operational status, and minimum charge points. Filter IDs are integers — resolve a connector or network name to its IDs with openchargemap_lookup_reference and pass every returned ID (e.g. "CCS" -> [32, 33]; Open Charge Map distinguishes CCS Type 1 (32, common in North America) and Type 2 (33, common in Europe); 33 alone can miss Type 1 stations). Each result includes title, address, distance from the search point (along a route: routeDistance along it and offRouteDistance off it), connections (type, power, count), operator, access rules, usage type ID, usage cost when on record, registry operational status, the last-verified date, and the data provider with its ID; the text output lists the license terms of each provider once per page, after the stations. Results come back one page at a time: when a page reports truncated, repeat the same search with the reported nextOffset to read the next one.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: FindStationsInput,

  output: z.object({
    stations: z
      .array(StationSchema)
      .describe(
        'Matching stations, nearest the search point first — the center of a radius search or of a bounding box — or in route order along a route.',
      ),
    searchSummary: z
      .string()
      .describe(
        'Human-readable echo of the resolved search: location mode, scope, and active filters as the server applied them.',
      ),
    attribution: z
      .string()
      .describe(
        'Attribution to Open Charge Map contributors and station data providers; license terms vary by provider.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Matching stations in the retrieved pool of up to 500 candidates, before offset/maxresults selects the page. Exact when no additional upstream stations remain; otherwise a floor. Stable across pages while the pool remains cached. The notice states whether additional upstream stations exist.',
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
      when: 'No search area was provided; or only one half of a center arrived; or a boundingbox or a route arrived alongside another location or a stray latitude or longitude; or Open Charge Map cannot search the route — a leg spans 180° of longitude or more, the corridor reaches past a pole or ±180° longitude, or the request runs past the 8,177 bytes Open Charge Map accepts.',
      recovery:
        'Provide exactly one location — latitude + longitude (+ optional distance), a boundingbox, or a route — with no leftover coordinate beside a box or a route. Geocode a place name with openstreetmap_search_places to obtain coordinates. A route the server cannot search names its own fix: add points to a long leg, narrow distance, or send fewer points.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'OCM returned a non-2xx response or timed out.',
      recovery:
        'Retry after a short delay. If it persists, OCM may be rate-limiting or down — reduce call frequency.',
      thrownBy: 'service',
    },
    {
      reason: 'auth_failed',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OCM returned HTTP 401 or 403 — the API key is missing or invalid.',
      recovery:
        'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org). This is a server configuration issue, not an input error.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const limit = applyPageLimit(input.maxresults, 200, 'find_stations', 'maxresults', ctx);
    input = { ...input, maxresults: limit.value };
    const notices: string[] = limit.notice ? [limit.notice] : [];
    const unknownCountry =
      input.countrycode !== undefined &&
      !getReferenceDataService().hasCountryCode(input.countrycode);
    if (unknownCountry)
      notices.push(
        `Country code ${input.countrycode?.toUpperCase()} is not an Open Charge Map country code; the search ran without a country restriction. Resolve valid codes with openchargemap_lookup_reference (category countries).`,
      );
    const { latitude, longitude, boundingbox, route } = input;
    // A boundingbox or a route rules out either coordinate, not just a complete center, so a stray
    // latitude is rejected rather than silently dropped.
    const noCoordinate = latitude === undefined && longitude === undefined;
    let location: SearchLocation;
    if (route && !boundingbox && noCoordinate) {
      location = {
        mode: 'route',
        route,
        distance: input.distance,
        distanceUnit: input.distanceUnit,
      };
    } else if (boundingbox && !route && noCoordinate) {
      location = { mode: 'box', box: boundingbox, distanceUnit: input.distanceUnit };
    } else if (!boundingbox && !route && latitude !== undefined && longitude !== undefined) {
      location = {
        mode: 'radius',
        latitude,
        longitude,
        distance: input.distance,
        distanceUnit: input.distanceUnit,
      };
    } else {
      throw ctx.fail(
        'invalid_location',
        locationFailure({
          hasLatitude: latitude !== undefined,
          hasLongitude: longitude !== undefined,
          hasBbox: boundingbox !== undefined,
          hasRoute: route !== undefined,
        }),
      );
    }

    const { area, fetched, matches, moreUpstream, reach } =
      await getOpenChargeMapService().searchPois(
        {
          location,
          ...(input.countrycode && !unknownCountry ? { countrycode: input.countrycode } : {}),
          ...(input.connectiontypeid !== undefined
            ? { connectiontypeid: input.connectiontypeid }
            : {}),
          ...(input.minpowerkw !== undefined ? { minpowerkw: input.minpowerkw } : {}),
          ...(input.operatorid !== undefined ? { operatorid: input.operatorid } : {}),
          ...(input.usagetypeid !== undefined ? { usagetypeid: input.usagetypeid } : {}),
          ...(input.levelid !== undefined ? { levelid: input.levelid } : {}),
          ...(input.statustypeid !== undefined ? { statustypeid: input.statustypeid } : {}),
          ...(input.minchargepoints !== undefined
            ? { minchargepoints: input.minchargepoints }
            : {}),
        },
        ctx,
      );
    ctx.log.info('OCM search complete', {
      fetched,
      matches: matches.length,
      mode: location.mode,
    });

    const stations = matches.slice(input.offset, input.offset + input.maxresults);
    /** One past the last station on this page — both the next offset and the more-left test. */
    const pageEnd = input.offset + stations.length;
    const moreRetrieved = matches.length > pageEnd;

    ctx.enrich.total(matches.length);
    if (moreRetrieved || moreUpstream) {
      ctx.enrich.truncated({
        shown: stations.length,
        cap: input.maxresults,
        guidance: [
          ...notices,
          truncationGuidance({
            area,
            matched: matches.length,
            moreRetrieved,
            moreUpstream,
            offset: input.offset,
            pageSize: stations.length,
            maxresults: input.maxresults,
            minchargepoints: input.minchargepoints !== undefined,
            ...(reach === undefined ? {} : { reach }),
          }),
        ].join(' '),
      });
      if (moreRetrieved) ctx.enrich({ nextOffset: pageEnd });
    } else {
      if (matches.length === 0)
        notices.push(
          `No charging stations matched ${buildSearchSummary(input, area, unknownCountry)} Widen the distance/bounding box, relax filters (drop minpowerkw, minchargepoints, or connectiontypeid), or remove countrycode. Verify the coordinates are on land in a covered region.`,
        );
      else if (stations.length === 0)
        notices.push(
          `This search matched ${matches.length} station(s), so offset ${input.offset} is past the end. Lower offset to read them.`,
        );
      if (notices.length) ctx.enrich.notice(notices.join(' '));
    }

    return {
      stations,
      searchSummary: buildSearchSummary(input, area, unknownCountry),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    // "Showing", not "Found" — this is one page, and the match count rides the enrichment trailer.
    const lines = [`Showing ${result.stations.length} station(s). ${result.searchSummary}`, ''];
    for (const block of renderStationPage(result.stations)) lines.push(block, '');
    lines.push(result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Name the specific location problem the caller hit. Every message states what actually arrived: a
 * route present here means something else came with it, a bounding box (without a route) means at
 * least one coordinate came with it, and the absence of both means at most one of latitude/longitude
 * arrived. A confidently-worded wrong diagnosis costs the caller more than a vague one, so the
 * lone-coordinate cases name the coordinate they got rather than borrowing the full-center wording.
 */
function locationFailure(supplied: {
  hasLatitude: boolean;
  hasLongitude: boolean;
  hasBbox: boolean;
  hasRoute: boolean;
}): string {
  if (supplied.hasRoute) {
    const coordinate =
      supplied.hasLatitude && supplied.hasLongitude
        ? 'a center (latitude + longitude)'
        : supplied.hasLatitude
          ? 'a latitude'
          : supplied.hasLongitude
            ? 'a longitude'
            : undefined;
    const others = [coordinate, supplied.hasBbox ? 'a boundingbox' : undefined].filter(Boolean);
    return `A route and ${others.join(' and ')} were supplied — provide exactly one location: a center (latitude + longitude), a boundingbox, or a route.`;
  }
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
  return 'No search area was provided — supply a center (latitude + longitude), a boundingbox, or a route.';
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
 * recovers their data (paging does). A confirmed upstream remainder leaves `matched` a floor, so no sentence may state
 * it as the number of matching stations.
 */
function truncationGuidance(page: {
  area: SearchArea;
  matched: number;
  maxresults: number;
  /** Whether the caller set minchargepoints, the one caller filter that runs on the retrieved pool. */
  minchargepoints: boolean;
  moreRetrieved: boolean;
  moreUpstream: boolean;
  offset: number;
  pageSize: number;
  reach?: number;
}): string {
  const total = page.moreUpstream
    ? `${page.matched} stations retrieved`
    : `${page.matched} matching stations`;
  const holdsMore = remainderGuidance(page.area, page.reach);
  const deeper = page.moreUpstream ? ` ${holdsMore}` : '';
  /** Only a sentence that names the count may call it a floor; the zero-match branch names none. */
  const counted = page.moreUpstream ? ` That count is a floor: ${holdsMore}` : '';
  if (page.moreRetrieved) {
    return `Showing ${page.pageSize} of ${total}, from offset ${page.offset}. Pass offset ${page.offset + page.pageSize} on the same search for the next ${page.maxresults}.${counted}`;
  }
  if (page.matched === 0) {
    // Every other filter ran upstream and chose which stations were retrieved, so relaxing one cannot
    // surface a station this pool held; the remainder's own advice covers the area.
    const relax = page.minchargepoints ? ' Relax minchargepoints.' : '';
    return `No station this search retrieved ${withinArea(page.area)}met the filters.${relax}${deeper}`;
  }
  if (page.pageSize === 0) {
    return `This search retrieved ${page.matched} station(s), so offset ${page.offset} is past the last one. Lower offset to read them.${counted}`;
  }
  return `Showing ${page.pageSize} of ${total}, from offset ${page.offset} — every station this search retrieved.${counted}`;
}

/**
 * The area test a retrieved station has to pass before the filters, as the zero-match notice names
 * it: a box and a route corridor narrow the upstream search down, a radius is the search itself.
 */
function withinArea(area: SearchArea): string {
  switch (area.mode) {
    case 'radius':
      return '';
    case 'box':
      return 'fell inside the box and ';
    case 'route':
      return `lay within ${area.distance} ${area.distanceUnit} of the route and `;
    default: {
      const unhandled: never = area;
      throw new Error(`Unhandled search area: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** A distance or coordinate as the notices print it: at most `places` decimals, trailing zeros dropped. */
function rounded(value: number, places: number): number {
  return Number(value.toFixed(places));
}

/**
 * What to say when a 501st record proves Open Charge Map holds more than the pool: how far the pool
 * reached in this location mode, when the pool carries distances, and how to reach the rest. The
 * reach is floored so it never claims coverage past the farthest retrieved record.
 */
function remainderGuidance(area: SearchArea, reach: number | undefined): string {
  const r = reach === undefined ? undefined : Math.floor(reach * 100) / 100;
  switch (area.mode) {
    case 'radius':
      return `Open Charge Map holds more stations than this search retrieved.${r === undefined ? '' : ` The retrieved stations reach ${r} of the ${area.distance} ${area.distanceUnit} radius.`} To reach the rest, narrow the radius or add filters.`;
    case 'box':
      return `Open Charge Map holds more stations than this search retrieved.${r === undefined ? '' : ` The retrieved stations cover the box out to ${r} ${area.distanceUnit} from its center (${rounded(area.latitude, 6)}, ${rounded(area.longitude, 6)}); its farthest point is ${rounded(area.distance, 2)} ${area.distanceUnit} away.`} To reach the rest, split the box into smaller boxes or add filters.`;
    // Route matches carry no distance and arrive by descending station ID, so the pool spans the
    // whole route and says nothing about how far along it the search reached.
    case 'route':
      return 'Open Charge Map holds more stations than this search retrieved. Route matches arrive newest first (by descending station ID), so stations added earlier may be missing anywhere along the route. To reach the rest, search shorter stretches of the route, narrow distance, or add filters.';
    default: {
      const unhandled: never = area;
      throw new Error(`Unhandled search area: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Compose a human-readable echo of the resolved search and active filters. */
function buildSearchSummary(
  input: z.infer<typeof FindStationsInput>,
  area: SearchArea,
  unknownCountry = false,
): string {
  const bits: string[] = [];
  switch (area.mode) {
    case 'radius':
      bits.push(
        `Within ${area.distance} ${area.distanceUnit} of ${area.latitude},${area.longitude}`,
      );
      break;
    case 'box': {
      const b = area.box;
      bits.push(
        `Bounding box (${b.sw_lat},${b.sw_lng})-(${b.ne_lat},${b.ne_lng})${area.crossesAntimeridian ? ' crossing the antimeridian (±180° longitude)' : ''}, distances in ${area.distanceUnit} from its center ${rounded(area.latitude, 6)},${rounded(area.longitude, 6)}`,
      );
      break;
    }
    case 'route':
      bits.push(
        `Within ${area.distance} ${area.distanceUnit} of a ${area.route.length}-point route (${rounded(area.length, 2)} ${area.distanceUnit} long)`,
      );
      break;
    default: {
      const unhandled: never = area;
      throw new Error(`Unhandled search area: ${JSON.stringify(unhandled)}`);
    }
  }
  if (input.countrycode)
    bits.push(
      unknownCountry
        ? `countrycode=${input.countrycode.toUpperCase()} (unrecognized, not applied)`
        : `country=${input.countrycode.toUpperCase()}`,
    );
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
