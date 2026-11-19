# openchargemap-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openchargemap_find_stations` | The workhorse. Find EV charging stations near a point (lat/long + distance), within a bounding box, or along a route, optionally scoped to a country. Filter by connector type, minimum power, operator/network, usage type (public, membership required, pay at location, private), operational status, and minimum charge points. Coordinate-native — geocode a place name with `openstreetmap_search_places` first. Returns each station's title, address, distance (along a route: `routeDistance` and `offRouteDistance`), connections (type/power/count), operator, access, usage type ID, usage cost when on record, operational status, last-verified date, and data provider with its ID; provider license terms are listed once per page in the text output. | `latitude`+`longitude`+`distance` OR `boundingbox` OR `route`; `distanceUnit?`, `countrycode?`, `connectiontypeid?`, `minpowerkw?`, `operatorid?`, `usagetypeid?`, `levelid?`, `statustypeid?`, `minchargepoints?`, `maxresults?`, `offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `openchargemap_get_station` | Full detail for one station by OCM numeric ID: every connection (type, level, power, current, quantity, status), operator + network, usage restrictions (pay/membership/access key), number of points, general comments, usage cost, site and operator contact details (withheld for a private residence), data provider with its license terms, media, the date the listing was created, and verification recency. Includes community check-ins inline when requested. | `id` (numeric OCM ID); `includeComments?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `openchargemap_lookup_reference` | Resolve Open Charge Map reference data → the integer IDs `find_stations` filters require. Turns "CCS", "CHAdeMO", "Tesla Supercharger", "Type 2", an operator name ("ChargePoint", "Tesla"), a usage type, a status, a current type, or a country name/code into its `connectiontypeid` / `operatorid` / `usagetypeid` / etc. Bundled and cached — offline, no network round trip. Browse a full category with no query. | `category` (enum), `query?` (name/code to resolve), `limit?`, `offset?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `openchargemap_get_station_comments` | Community check-ins and comments for one station — the honest reliability signal. Returns user-reported comments and fault reports with ratings and dates, plus the station's registry operational status and last-verified date so an agent can flag "listed operational, but recent check-ins report a fault." | `id` (numeric OCM ID); `maxresults?`, `offset?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `openchargemap://station/{id}` | Full station record by OCM numeric ID — the resource twin of `openchargemap_get_station`. | None — single record |
| `skill://openchargemap-guide/SKILL.md` | Charger recommendation, reliability, and coverage workflow guide, also discoverable through the MCP Skills extension. | None — one guide |

Resources are supplementary. All data is fully reachable through tools — the resource is a convenience for clients that support injectable context by stable URI. Reference data is **not** exposed as a resource (it is a query/resolve surface, not a stable-by-URI record; `openchargemap_lookup_reference` covers it).

### Prompts

None. The surface is find / detail / resolve — data-and-lookup oriented, no recurring multi-step interaction pattern that a prompt template would structure. (The route-planning "moonshot" in `idea.md` would warrant one, but it is explicitly out of scope for v1: the server does not plan routes. It searches along one the caller supplies.)

---

## Overview

Global electric-vehicle charging as one find-and-detail server over **Open Charge Map** (OCM) — the community-maintained, nonprofit registry of public charging stations worldwide (~200k+ locations across Europe, North America, Asia, and Oceania). Find chargers near a point or within a region, filtered by connector, power, and network; pull full station detail; resolve the connector/operator reference data those filters key on; and read community check-ins for real-world reliability.

A companion `openstreetmap` MCP server already covers geocoding and places, but nothing covers the EV-charging layer that rides on top of it. OCM is a global, community-maintained registry with provider-specific license terms, and "where can I charge near here, with the right connector, that actually works" is a real, recurring query. It composes directly with `openstreetmap` (geocode a place → coordinate search).

**Audience:** EV drivers and trip-planning assistants, mobility and fleet-management tooling, mapping and travel agents — anyone resolving "nearest working charger for this car" anywhere in the world.

**Scope:** Read-only v1. Global by default — country is an optional filter, never a hardcoded default. No DataCanvas (find/detail/resolve surface, not analytical rows). Preserve contributor and provider attribution and expose per-provider license terms.

---

## Requirements

- **POI geo-search** via OCM `/v3/poi` by radius (`latitude` + `longitude` + `distance`), bounding box (`boundingbox`, searched as a radius from its center and narrowed to the box), or route (`route`, sent as a `polyline`), optionally scoped by `countrycode`, with filters: `connectiontypeid`, `minpowerkw`, `operatorid`, `usagetypeid`, `levelid`, `statustypeid`, `minchargepoints`.
- **Single-station detail** via OCM `/v3/poi?chargepointid=<id>` (numeric only; UUID lookup is not supported by the API — passing a UUID as `chargepointid` returns 100 random stations) — full connection/operator/usage breakdown, comments inline when requested.
- **Reference-data resolution** — friendly name → integer filter ID, served from a bundled snapshot (offline, zero-latency), refreshed on startup with the snapshot as fallback.
- **Community reliability** — user comments/check-ins (embedded in the POI via `includecomments=true`) plus `DateLastVerified` and registry `StatusType`, surfaced together so registry-vs-reality mismatch is visible.
- **Coordinate-native** — the server does not geocode place names; document the `openstreetmap_search_places` two-step in `find_stations`' description.
- **Auth:** OCM requires an `X-API-Key` request header on every endpoint (`/poi`, `/referencedata`). Key is free (instant signup). A missing or invalid key returns **HTTP 403**.
- **Rate limits:** generous community limits, no hard published number — be polite: cache reference data, default `maxresults` modestly, enforce session-level caching in the service.
- **Global coverage**, read-only, no writes (OCM accepts POI/comment submissions but writes need moderation and add little agent value → deferred).
- **Attribution:** Credit Open Charge Map contributors and the providers named on each station in README and every tool's output metadata (`attribution` field). License terms vary by provider.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenChargeMapService` | OCM POI API (`/v3/poi`) — live charging-station + embedded-comment data; HTTP client with retry + session-level `ctx.state` caching | `openchargemap_find_stations`, `openchargemap_get_station`, `openchargemap_get_station_comments`, `openchargemap://station/{id}` |
| `ReferenceDataService` | Bundled OCM reference snapshot (`src/data/ocm-reference-data.ts`) + optional startup refresh from `/v3/referencedata`; builds name→ID indices per category | `openchargemap_lookup_reference`; consulted by `find_stations` to label resolved filters and by detail/find formatters to name IDs |

**`OpenChargeMapService`** — stateless HTTP client. One method per tool need: `searchPois(params)`, `getPoi(id, { includeComments })`. Sets `X-API-Key` from config on every request, always `output=json&compact=false`. **Search** uses `verbose=false`; **detail** (`getPoi`) uses `verbose=true`. The flag only decides whether null-valued keys are sent: both responses carry every populated field, so the two paths differ in payload size, not in what a station can expose. `withRetry` wraps the full fetch+parse pipeline under one 50 s deadline (inside the 60 s client timeout) with backoff calibrated for a rate-limited upstream (base ~1.5s); each attempt's fetch carries the ladder's signal, so the deadline also ends an attempt in flight. Each attempt has a 15 s request timeout; a route search that runs it out fails once, not retried, with a recovery asking for fewer points. A `Retry-After` from upstream paces the retry (waited out when the ladder allows, otherwise the call fails at once) and reaches the caller as `data.retryAfter` on `upstream_unavailable`; a permanent upstream rejection (a status the same request will get again, such as 400 or 414) is not retried and its recovery tells the caller to change the request's inputs. Session-level result cache in `ctx.state` keyed by the full param set (TTL ~10 min — station status changes but not second-to-second).

**`ReferenceDataService`** — init/accessor. At `setup()`:
1. Load the bundled snapshot (a TS const committed to the repo, captured from `/v3/referencedata`) — this is the source of truth and the offline fallback.
2. **Optionally** refresh from the live `/v3/referencedata` endpoint (gated by `OPENCHARGEMAP_REFERENCE_REFRESH`, default off): on success, replace the in-memory set; on any failure, log a warning and keep the bundled snapshot. Never let a refresh failure block startup.
3. Build per-category lookup indices: exact-ID map, word-start index over titles and formal names, separator-free exact-key map, and alias maps per category (connection types, charge levels, countries) so "J1772" → Type 1, "Supercharger" → NACS, "UK" → United Kingdom, "DC fast" → level 3, etc.

Reference sets are small and bounded (measured live: ConnectionTypes 43, Operators 974, Countries 250, CurrentTypes 3, ChargerTypes/levels 3, StatusTypes 10, UsageTypes 8, plus CheckinStatusTypes 18, UserCommentTypes 5, DataProviders 53) — total well under 1 MB. Bundling beats a hard runtime dependency on the reference endpoint; the optional refresh keeps it from drifting.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OPENCHARGEMAP_API_KEY` | **Yes** | OCM API key, sent as the `X-API-Key` header on every request. Free instant signup at openchargemap.org. Startup fails fast with a `ConfigurationError` banner if unset. |
| `OPENCHARGEMAP_BASE_URL` | No | Override the OCM API base (default `https://api.openchargemap.io/v3`). For a private mirror or testing. |
| `OPENCHARGEMAP_REFERENCE_REFRESH` | No | `z.stringbool()`, default `false`. When `true`, refresh reference data from `/v3/referencedata` at startup, falling back to the bundled snapshot on failure. When `false`, use the bundled snapshot only (fully offline). |
| `OPENCHARGEMAP_CLAMP_LIMITS` | No | `z.stringbool()`, default `true`. Clamp oversized positive integer page sizes to 200 stations or 100 comments/reference entries. `false` restores rejection. Each clamp emits one notice, log and `openchargemap.pagination.clamps` increment with bounded tool/parameter labels. |

`server-config.ts` is a lazy-parsed Zod schema separate from framework config; `parseEnvConfig` maps schema paths → env var names so errors name `OPENCHARGEMAP_API_KEY`, not `apiKey`. Use `z.stringbool()` for the boolean (never `z.coerce.boolean()`).

> **Wiring note:** the env var is exactly `OPENCHARGEMAP_API_KEY`. It must appear in `server-config.ts`, `server.json` (`environmentVariables[]`), `manifest.json` (`mcp_config.env` + `user_config`), `.claude-plugin/plugin.json`'s `mcpServers` env block, and `.codex-plugin/mcp.json` — `lint:packaging` cross-checks `server.json` ↔ `manifest.json`.

---

## Implementation Order

1. **Config + server setup** — `server-config.ts` with the server-specific env vars; wire `createApp({ name: 'openchargemap-mcp-server', title: 'openchargemap-mcp-server', websiteUrl: '<repo>', tools: […] })`. Do **not** pass `description`/`websiteUrl` duplicates of package.json into the identity block beyond `websiteUrl`; `description` derives from package.json.
2. **`src/data/ocm-reference-data.ts`** — bundled reference snapshot (TS const) + a `REFERENCE_SNAPSHOT_DATE` marker.
3. **`ReferenceDataService`** — load snapshot, build indices, optional startup refresh.
4. **`OpenChargeMapService`** — HTTP client, retry, session cache, response normalization.
5. **`openchargemap_lookup_reference`** (no live dependency beyond the service — testable first).
6. **`openchargemap_find_stations`** (the workhorse).
7. **`openchargemap_get_station`**.
8. **`openchargemap_get_station_comments`**.
9. **`openchargemap://station/{id}`** resource.

Each step is independently testable. Tests must include at least one sparse-payload case (OCM omits `NumberOfPoints`, `UsageCost`, `GeneralComments`, `UserComments`, `MediaItems`, and nullifies connection fields freely; `StatusType` key can be entirely absent from some POI records — see API Reference).

---

## Tool Detail

### `openchargemap_find_stations`

The workhorse. Wraps `GET /v3/poi`. Coordinate-native; place names geocode through `openstreetmap_search_places` first (documented in the description, not implemented here).

**Description (final):**
> Find EV charging stations from the global Open Charge Map registry near a point, within a bounding box, or along a route. Provide one location: a center (`latitude` + `longitude` + `distance`), a `boundingbox`, or a `route` (its points in travel order, with `distance` as the corridor half-width); optionally scope to a country with `countrycode`. This tool is coordinate-native and does not geocode place names — resolve a place like "Ballard, Seattle" to coordinates with `openstreetmap_search_places` first, then pass them here. Filter by connector type, minimum power (kW), operator/network, usage type (public, membership required, pay at location, private; price is not a usage type), charge level, operational status, and minimum charge points. Filter IDs are integers — resolve a connector or network name to its IDs with `openchargemap_lookup_reference` and pass every returned ID (e.g. "CCS" -> [32, 33]; Open Charge Map distinguishes CCS Type 1 (32, common in North America) and Type 2 (33, common in Europe); 33 alone can miss Type 1 stations). Each result includes title, address, distance from the search point (along a route: `routeDistance` along it and `offRouteDistance` off it), connections (type, power, count), operator, access rules, usage type ID, usage cost when on record, registry operational status, the last-verified date, and the data provider with its ID; the text output lists the license terms of each provider once per page, after the stations. Results come back one page at a time: when a page reports truncated, repeat the same search with the reported `nextOffset` to read the next one.

**Input:**

```ts
z.object({
  // --- Location: radius OR bbox OR route (validated in handler: exactly one mode) ---
  latitude: z.number().min(-90).max(90).optional()
    .describe('Center latitude (WGS84 decimal degrees). Use with longitude + distance for a radius search. Resolve place names via openstreetmap_search_places first.'),
  longitude: z.number().min(-180).max(180).optional()
    .describe('Center longitude (WGS84 decimal degrees). Use with latitude + distance for a radius search.'),
  distance: z.number().positive().max(500).default(25)
    .describe('Search radius from the center point — or, along a route, the corridor half-width: how far from the route a station may sit — in the unit given by distanceUnit (default km). Max 500. For a radius, keep small (5-25) in dense urban areas and widen for rural coverage; for a driving corridor, 2-10 km is typical.'),
  distanceUnit: z.enum(['KM', 'Miles']).default('KM')
    .describe('Unit for the distance parameter and the returned distance values.'),
  boundingbox: z.object({
    sw_lat: z.number().min(-90).max(90).describe('South-west corner latitude.'),
    sw_lng: z.number().min(-180).max(180).describe('South-west corner longitude.'),
    ne_lat: z.number().min(-90).max(90).describe('North-east corner latitude.'),
    ne_lng: z.number().min(-180).max(180).describe('North-east corner longitude.'),
  }).optional()
    .describe('Bounding-box search as an alternative to a center+radius. The box is searched outward from its center, so its stations come back nearest the center first, each with its distance from the center in distanceUnit. The latitude corners may come in either order; a sw_lng greater than ne_lng spans the ±180° meridian (e.g. sw_lng 170, ne_lng -170 is the 20° around it, not the 340° between). Mutually exclusive with latitude/longitude/distance and route — sending a boundingbox alongside a latitude or a longitude is rejected, not resolved in favour of one of them.'),
  route: z.array(z.object({
    latitude: z.number().min(-90).max(90).describe('Point latitude (WGS84 decimal degrees).'),
    longitude: z.number().min(-180).max(180).describe('Point longitude (WGS84 decimal degrees).'),
  }).describe('One route point.')).min(2).max(500).optional()
    .describe("Search along a route instead of around a point or in a box: its points in travel order, 2 to 500 of them — waypoints, or a routing service's geometry. Each leg runs the shortest way between its two points, and distance becomes the corridor half-width. Stations within it come back in the order a driver meets them, each with routeDistance (along the route from its first point) and offRouteDistance (off the route), in distanceUnit. Mutually exclusive with latitude/longitude and boundingbox. Each leg must span less than 180° of longitude, so a route cannot cross ±180°."),

  // --- Scope + filters (all optional; integer IDs resolve via openchargemap_lookup_reference) ---
  countrycode: z.string().length(2).regex(/^[A-Za-z]{2}$/).optional()
    .describe('Restrict to one country by ISO 3166-1 alpha-2 code (e.g. "US", "FR", "GB"). Omit for a global search. An unrecognized code is not applied; the summary and notice disclose the unrestricted search. Resolve valid codes with openchargemap_lookup_reference (countries).'),
  connectiontypeid: z.union([z.number().int().min(0), z.array(z.number().int().min(0)).min(1).max(10)]).optional()
    .describe('Connector type ID, or an array of IDs (OR-matched). Resolve names with openchargemap_lookup_reference — e.g. CCS is two IDs, 32 (Type 1, North America) and 33 (Type 2, Europe and most other regions), so pass [32, 33] when the region is unknown; CHAdeMO=2, NACS/Tesla Supercharger=27, Type 2 socket=25, Type 1/J1772=1.'),
  minpowerkw: z.number().positive().max(1000).optional()
    .describe('Minimum charging power in kW across any connection at the station. Use ~50 for DC fast charging, ~150 for high-power DC. Stations whose fastest connection is below this are excluded.'),
  operatorid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(10)]).optional()
    .describe('Operator/network ID, or array of IDs (OR-matched). Resolve a network name with openchargemap_lookup_reference (category "operators") — e.g. "Tesla", "ChargePoint".'),
  usagetypeid: z.union([z.number().int().min(0), z.array(z.number().int().min(0)).min(1).max(10)]).optional()
    .describe('Usage/access type ID, or array (OR-matched). Resolve via openchargemap_lookup_reference (category "usagetypes") — e.g. Public=1, Public-Pay At Location=5, Public-Membership Required=4.'),
  levelid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(3)]).optional()
    .describe('Charge level ID (1=Low <2kW, 2=Medium >2kW, 3=High >40kW/fast). Array OR-matched. Use 3 as a coarse "fast charging only" filter when a specific connector is not required.'),
  statustypeid: z.union([z.number().int().min(0), z.array(z.number().int().min(0)).min(1).max(10)]).optional()
    .describe('Registry operational-status ID, or array (OR-matched). Resolve via openchargemap_lookup_reference (category "statustypes"). NOTE: registry status is operator-reported and can be stale — combine with dateLastVerified and openchargemap_get_station_comments to judge real-world reliability, do not treat it as ground truth.'),
  minchargepoints: z.number().int().positive().optional()
    .describe('Minimum number of charge points (stalls) at the station. Filters out single-point locations when you need a station likely to have an open stall.'),

  maxresults: pageLimitSchema(200).default(25)
    .describe('Maximum stations to return, nearest the search point first — the center of a radius search or of a bounding box — or in route order along a route. Max 200; larger values are clamped to 200.'),
  offset: z.number().int().min(0).max(499).default(0)
    .describe('Matching stations to skip before the returned page, for reading past a truncated result. Repeat the same search with the nextOffset value the previous call reported. One search reaches at most 500 stations, so 499 is the deepest offset that can return one — narrow the area or add filters to reach stations beyond that. Ordering is by distance from the search point (a bounding box\'s center), or along a route by routeDistance then offRouteDistance, with station ID breaking ties, and stable, but Open Charge Map is edited continuously, so a station added or removed between pages can shift what a later offset lands on.'),
})
```

**Output:**

```ts
z.object({
  stations: z.array(z.object({
    id: z.number().describe('OCM station ID.'),
    uuid: z.string().describe('OCM station UUID — stable cross-system identifier (cannot be used as a lookup input).'),
    title: z.string().describe('Station name / location title.'),
    address: z.object({
      line1: z.string().optional().describe('Street address line.'),
      line2: z.string().optional().describe('Second address line (e.g. a district or building). Absent when none on record.'),
      town: z.string().optional().describe('Town or city.'),
      stateOrProvince: z.string().optional().describe('State or province.'),
      postcode: z.string().optional().describe('Postal/ZIP code.'),
      country: z.string().optional().describe('Country name.'),
      countryCode: z.string().optional().describe('ISO 3166-1 alpha-2 country code.'),
      latitude: z.number().describe('Station latitude (WGS84).'),
      longitude: z.number().describe('Station longitude (WGS84).'),
      accessComments: z.string().optional().describe('Free-text access notes (e.g. "24 hours daily").'),
    }).describe('Structured station address and coordinates.'),
    distance: z.number().optional().describe('Distance from the search point: the center of a radius search or of a bounding box. Absent along a route, which reports routeDistance and offRouteDistance instead.'),
    routeDistance: z.number().optional().describe("Route searches only: distance along the route from its first point to the station's nearest point on the route — the order a driver meets stations."),
    offRouteDistance: z.number().optional().describe('Route searches only: distance from the station to its nearest point on the route — the detour off it. At most the requested distance.'),
    distanceUnit: z.enum(['KM', 'Miles']).optional().describe('Unit of distance, routeDistance, and offRouteDistance.'),
    operator: z.string().optional().describe('Operating network name (e.g. "ChargePoint", "Tesla"). Absent when OCM has no operator on record.'),
    operatorId: z.number().optional().describe('OCM operator ID — resolve names via openchargemap_lookup_reference.'),
    usageType: z.string().optional().describe('Access/usage type title (e.g. "Public", "Public - Pay At Location"). Absent when OCM has no usage type.'),
    usageTypeId: z.number().optional().describe('Usage type ID — the value the openchargemap_find_stations usagetypeid filter takes. 0 is OCM\'s "(Unknown)" type. Absent when OCM has no usage type on record.'),
    usageCost: z.string().optional().describe('Free-text cost description as recorded (e.g. "£0.30/kWh"). Often absent — absence means unknown, not free.'),
    isPayAtLocation: z.boolean().optional().describe('Whether payment is required at the location. Absent when usage type is unknown.'),
    isMembershipRequired: z.boolean().optional().describe('Whether a membership or RFID card is required. Absent when usage type is unknown.'),
    isAccessKeyRequired: z.boolean().optional().describe('Whether a physical access key is required. Absent when usage type is unknown.'),
    numberOfPoints: z.number().optional().describe('Reported number of charge points (stalls). Often absent — absence means unknown, not zero.'),
    status: z.string().optional().describe('Registry operational status (e.g. "Operational", "Temporarily Unavailable"). Operator-reported; may be stale.'),
    statusTypeId: z.number().optional().describe('Registry status ID — the value the openchargemap_find_stations statustypeid filter takes. Absent when OCM has no status on record.'),
    isOperational: z.boolean().optional().describe('Whether the registry marks the status operational. Absent when the operational state is unknown. A true value can still mask a broken charger — corroborate with comments and dateLastVerified.'),
    dateLastVerified: z.string().nullable().optional().describe('ISO 8601 date the listing was last verified. Stale (>12 months) is a reliability caveat. null when never verified.'),
    isRecentlyVerified: z.boolean().optional().describe('Whether the listing was verified recently.'),
    connections: z.array(z.object({
      statusTypeId: z.number().optional().describe('Registry status ID for this connector; absent when no status ID is on record.'),
      status: z.string().optional().describe('Registry status title for this connector.'),
      isOperational: z.boolean().optional().describe('Faithful registry operational flag for this connector; absent when unknown.'),
      notes: z.string().optional().describe('Provider notes about this connector.'),
      connectionTypeId: z.number().optional().describe('Connector type ID — resolve via openchargemap_lookup_reference.'),
      connectionType: z.string().optional().describe('Connector type title (e.g. "CCS (Type 2)", "CHAdeMO").'),
      level: z.string().optional().describe('Charge level title (e.g. "Level 2 : Medium (Over 2kW)").'),
      levelId: z.number().optional().describe('Charge level ID (1/2/3).'),
      powerKW: z.number().nullable().optional().describe('Rated power in kW for this connection. null/absent when unknown.'),
      currentType: z.string().optional().describe('Current type (e.g. "AC (Single-Phase)", "DC").'),
      amps: z.number().nullable().optional().describe('Rated amperage. Often null.'),
      voltage: z.number().nullable().optional().describe('Rated voltage. Often null.'),
      quantity: z.number().nullable().optional().describe('Number of connectors of this type. null when unknown.'),
    })).describe('Connectors at the station. Empty when OCM has no connection data on record.'),
    dataProvider: z.string().optional().describe('Source that provided the listing (e.g. "afdc.energy.gov").'),
    dataProviderId: z.number().optional().describe('OCM data provider ID. Provider titles are not unique — two providers can share one with different license terms — so the ID is what identifies the provider.'),
    dataProviderLicense: z.string().optional().describe('License terms supplied by the station data provider. Absent when unspecified.'),
    isOpenDataLicensed: z.boolean().optional().describe('Whether the provider marks its data as openly licensed. Absent when unknown.'),
  })).describe('Matching stations, nearest the search point first — the center of a radius search or of a bounding box — or in route order along a route.'),
  searchSummary: z.string().describe('Human-readable echo of the resolved search: location mode, scope, and active filters as the server applied them.'),
  attribution: z.string().describe('Attribution to Open Charge Map contributors and station data providers; license terms vary by provider.'),
})
```

`totalCount` via `ctx.enrich.total(n)`, declared on the enrichment block: the matching stations in the retrieved pool of up to 500 candidates, before `offset`/`maxresults` selects the page — exact when no additional upstream stations remain, otherwise a floor. Truncation via `ctx.enrich.truncated({ shown, cap })` — the standard `truncated` / `shown` / `cap` fields (with `nextOffset` and `notice`) are populated by the framework **only when a page leaves stations out**, so they are declared on the enrichment block, never as required `output` fields (declaring them required throws `-32007` on every non-truncated result). `searchSummary` and `attribution` carry agent-facing context that must reach both client surfaces — put them in `output` (so `format-parity` drags them into `format()`); the truncation block rides `enrichment`.

**`format()`** renders: a header line with `searchSummary`, then per station a block — `**{title}** — {distance} {unit}` / a `Route: {routeDistance} {unit} along, {offRouteDistance} {unit} off it` line in route mode / address / operator + usageType (each followed by its ID, `Operator: id N` when only the ID is known) / `Usage cost` / `Data provider: {name} (id N)` / each connection as `{connectionType} · {powerKW} kW · {currentType} ×{quantity}` / a status line `Status: {status} · last verified {dateLastVerified}` with an explicit caveat when `dateLastVerified` is stale or `isOperational` is false/null. After the last station, a closing `Data providers:` block lists one entry per provider ID — `  - {name} (id N) · open data licensed: yes|no · Provider license: {text|unspecified}` — so terms every row shares appear once per page; a station with no provider ID, or terms that differ from the entry listed under its ID, keeps its terms inline. The attribution closes the text. Every `output` field appears in the rendered text (lint-enforced).

**Errors:**

```ts
errors: [
  { reason: 'invalid_location', code: JsonRpcErrorCode.InvalidParams,
    when: 'No search area was provided; or only one half of a center arrived; or a boundingbox or a route arrived alongside another location or a stray latitude or longitude; or Open Charge Map cannot search the route — a leg spans 180° of longitude or more, the corridor reaches past a pole or ±180° longitude, or the request runs past the 8,177 bytes Open Charge Map accepts.',
    recovery: 'Provide exactly one location — latitude + longitude (+ optional distance), a boundingbox, or a route — with no leftover coordinate beside a box or a route. Geocode a place name with openstreetmap_search_places to obtain coordinates. A route the server cannot search names its own fix: add points to a long leg, narrow distance, or send fewer points.' },
  { reason: 'upstream_unavailable', code: JsonRpcErrorCode.ServiceUnavailable, retryable: true,
    when: 'OCM returned a non-2xx response or timed out.',
    recovery: 'Retry after a short delay. If it persists, OCM may be rate-limiting or down — reduce call frequency.' },
  { reason: 'auth_failed', code: JsonRpcErrorCode.Unauthorized,
    when: 'OCM returned HTTP 401 or 403 — the API key is missing or invalid.',
    recovery: 'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org). This is a server configuration issue, not an input error.' },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`.

---

### `openchargemap_get_station`

Full detail for one station. Wraps `GET /v3/poi?chargepointid=<id>` (numeric only). **UUID lookup is not supported** — passing a UUID string as `chargepointid` returns 100 random stations, not the matching station (verified). The `id` input accepts numeric IDs only. A non-existent numeric ID returns OCM HTTP 200 with `[]` — the handler detects the empty array and throws `not_found` (it must **not** return an empty/null station).

**Description (final):**
> Get the full record for one Open Charge Map station by its numeric OCM ID. Returns every connection (type, level, power, current, quantity, per-connection status), the operator and network, usage and access restrictions (pay-at-location, membership, access key), the number of charge points, general comments, usage cost, the site and operator contact details on record (site phone and web page, operator website, phone, and fault-report email; never returned for a private residence), the data provider with its license terms, media, the date the listing was created, and verification recency. Set includeComments to also return community check-ins inline.

**Input:**

```ts
z.object({
  id: z.number().int().positive()
    .describe('Numeric OCM station ID (e.g. 145452).'),
  includeComments: z.boolean().default(false)
    .describe('Include community check-ins and comments inline in the response. Adds payload but gives the real-world reliability signal alongside the registry status. Every comment on record comes back at once, unpaged — on a station with hundreds of check-ins that is a large response, so prefer openchargemap_get_station_comments, which returns them a page at a time.'),
})
```

**Output:** A single `station` object — the `find_stations` station shape **plus** detail-only fields:

```ts
z.object({
  station: z.object({
    // ...all fields from the find_stations station shape, plus:
    generalComments: z.string().optional().describe('Operator/free-text notes about the station. Absent when none on record.'),
    // Contact fields are withheld when OperatorInfo.IsPrivateIndividual is true (a private residence).
    contactPhone: z.string().optional().describe('Site contact phone, free text as recorded. Absent when none on record or when the station is a private residence.'),
    contactPhoneSecondary: z.string().optional().describe('Second site contact, free text as recorded (occasionally an email address). Absent when none on record or when the station is a private residence.'),
    relatedUrl: z.string().optional().describe('Web page for the site (network or venue page). Absent when none on record or when the station is a private residence.'),
    operatorWebsite: z.string().optional().describe("Operator network's website. Absent when none on record or when the station is a private residence."),
    operatorPhone: z.string().optional().describe("Operator network's primary contact phone. Absent when none on record or when the station is a private residence."),
    operatorFaultReportEmail: z.string().optional().describe("Operator network's address for reporting a faulty charger. Absent when none on record or when the station is a private residence."),
    dateCreated: z.string().optional().describe('ISO 8601 timestamp the listing was added to Open Charge Map.'),
    dataProviderUrl: z.string().optional().describe('Source provider website.'),
    dateLastStatusUpdate: z.string().nullable().optional().describe('ISO 8601 timestamp of the last status update.'),
    submissionStatus: z.string().optional().describe('OCM submission/publication status (e.g. "Imported and Published").'),
    media: z.array(z.object({
      url: z.string().describe('Image URL.'),
      comment: z.string().optional().describe('Caption / comment.'),
    })).optional().describe('User-submitted photos of the station. Absent when none.'),
    comments: z.array(z.object({
      user: z.string().optional().describe('Commenter username. Absent for anonymous.'),
      commentType: z.string().optional().describe('Comment type (e.g. "General Comment", "Fault Report").'),
      checkinStatus: z.string().optional().describe('The visit outcome the driver recorded (e.g. "Charged Successfully", "Failed to Charge (Equipment Not Operational)"). Carries the result on check-ins that have no comment text. Absent when the visitor recorded no outcome.'),
      checkinStatusId: z.number().optional().describe('Numeric ID of the check-in outcome, stable across renames of its title.'),
      checkinStatusIsPositive: z.boolean().optional().describe('Whether the registry classes this outcome as a good visit. Absent when the outcome carries no verdict either way (e.g. "Did Not Visit Location") or when none was recorded.'),
      comment: z.string().optional().describe('Comment text.'),
      rating: z.number().nullable().optional().describe('User rating 1–5. null when not given.'),
      relatedUrl: z.string().optional().describe('Link the commenter attached. Absent when none was given.'),
      dateCreated: z.string().optional().describe('ISO 8601 timestamp the comment was posted.'),
    })).optional().describe('Community check-ins, present only when includeComments=true. Empty array means none on record.'),
  }).describe('The full station record.'),
  reliabilityNote: z.string().optional().describe('A caveat when the registry status, verification age, coordinates, or comments suggest the listing may not reflect reality. Omitted when there is nothing to flag.'),
  attribution: z.string().describe('Attribution to Open Charge Map contributors and station data providers; license terms vary by provider.'),
})
```

> **`reliabilityNote` is honest signal, not a fabricated score.** It is plain prose derived from observable facts the server has — `dateLastVerified` age, `isOperational`, and the count of fault-type vs. positive comments when present. No synthetic confidence percentage or composite metric (per the no-fabricated-signal rule). Omitted entirely when there is nothing to caveat.

**Errors:**

```ts
errors: [
  { reason: 'not_found', code: JsonRpcErrorCode.NotFound,
    when: 'OCM returned an empty result for the given numeric ID (HTTP 200 with []) — no such station.',
    recovery: 'Verify the numeric OCM ID. Find a valid station first with openchargemap_find_stations.' },
  { reason: 'upstream_unavailable', code: JsonRpcErrorCode.ServiceUnavailable, retryable: true,
    when: 'OCM returned a non-2xx response or timed out.',
    recovery: 'Retry after a short delay. If it persists, OCM may be rate-limiting or down.' },
  { reason: 'auth_failed', code: JsonRpcErrorCode.Unauthorized,
    when: 'OCM returned HTTP 401 or 403 — the API key is missing or invalid.',
    recovery: 'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org). This is a server configuration issue, not an input error.' },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`.

---

### `openchargemap_lookup_reference`

The DX layer. Resolves friendly names to the integer filter IDs `find_stations` needs, served from the bundled/cached reference snapshot — **no network round trip** (`openWorldHint: false`). Also browses a full category when `query` is omitted. This is the bounded-set, name→opaque-ID resolver pattern (MCP-side list filtering): word-start token match over the full category, no fuzzy library for the default path.

**Description (final):**
> Resolve Open Charge Map reference data to the integer IDs that openchargemap_find_stations filters require. Pick a category and pass a name or code to resolve — "CCS" or "Tesla Supercharger" -> a connectiontypeid, "ChargePoint" -> an operatorid, "Public - Pay At Location" -> a usagetypeid, "France" or "FR" -> a country. A connector name can resolve to several regional variants ("CCS" matches CCS Type 2 = 33 and CCS Type 1 = 32, the North American form) — pass every returned ID to find_stations as an array, not just the first. Omit the query to browse the whole category. Large categories come back one page at a time: when a page reports truncated, repeat the call with the reported nextOffset to read the next one.

**Input:**

```ts
z.object({
  category: z.enum([
    'connectiontypes',
    'operators',
    'usagetypes',
    'statustypes',
    'currenttypes',
    'levels',
    'countries',
  ]).describe('Which reference set to query. connectiontypes -> connectiontypeid; operators -> operatorid; usagetypes -> usagetypeid; statustypes -> statustypeid; currenttypes -> current type; levels -> charge level (1/2/3); countries -> ISO country.'),
  query: z.string().regex(/\S/, 'query must contain at least one non-whitespace character').optional()
    .describe('Name, title, code, or alias to resolve (e.g. "CCS", "CHAdeMO", "Tesla", "Public", "France", "FR", "UK", "DC fast"). Case-insensitive; accents, spacing, and punctuation are ignored ("J-1772", "Euro plug"). Each query word must start a word of the title or formal name, in any order — including a part of a joined word ("point" finds ChargePoint), never the middle of one ("US" does not match Australia). Known aliases cover connectors, countries, and charge levels ("UK" -> United Kingdom, "DC fast" -> level 3). Omit to browse the entire category.'),
  limit: pageLimitSchema(100).default(25)
    .describe('Maximum entries to return when browsing or when a query matches several. Max 100; larger values are clamped to 100.'),
  offset: z.number().int().min(0).default(0)
    .describe('Entries to skip before the returned page, for reading past a truncated result. Repeat the same call with the nextOffset value the previous one reported. Applies to browsing and to a query with many matches alike; the order is stable, so every entry is reachable by paging.'),
})
```

**Output:**

```ts
z.object({
  category: z.string().describe('The reference category queried.'),
  matches: z.array(z.object({
    id: z.number().describe('The reference ID for this entry.'),
    title: z.string().describe('Human-readable title (e.g. "CCS (Type 2)", "ChargePoint", "United States").'),
    formalName: z.string().nullable().optional().describe('Formal/standard name where applicable. null when none.'),
    isoCode: z.string().optional().describe('ISO 3166-1 alpha-2 code — countries category only.'),
    detail: z.string().optional().describe('Extra interpretive context (operational flag, pay/membership/access, discontinued/obsolete, continent).'),
  })).describe('Matching reference entries, best/exact match first.'),
  filterParam: z.string().optional().describe('The find_stations input parameter these IDs feed (e.g. "connectiontypeid"). Omitted for categories with no direct filter (currenttypes; countries use countrycode).'),
  snapshotDate: z.string().describe('Date the reference data in this response was captured, so callers know its vintage — the day the live refresh ran when source is "live", the bundled snapshot\'s own capture date when source is "bundled". Read it together with source: the same date can mean either a fresh fetch or a freshly cut bundle.'),
  source: z.enum(['live', 'bundled']).describe('Where these entries came from. "live" — a startup refresh from Open Charge Map returned a complete set and is what is being served. "bundled" — the snapshot shipped with the server is being served, either because the refresh is switched off or because it failed and the server fell back to the bundle.'),
  attribution: z.string().describe('Attribution to Open Charge Map contributors and station data providers; license terms vary by provider.'),
})
```

`totalCount` via `ctx.enrich.total(n)`; truncation (browsing a category larger than `limit` — only `operators`/`countries` exceed it) via `ctx.enrich.truncated({ shown, cap })`, declared on the enrichment block. `format()` renders each match as `{id} — {title}{ formalName/isoCode/detail }`, then `filterParam` guidance, then `source` + `snapshotDate` + attribution.

**Matching:** fold the text (compatibility-decompose, drop the combining diacritics of Latin, Greek, and Cyrillic, map letters Unicode does not decompose — ø, ı, ð, æ, ß and the like — to their Latin base; other scripts' letters are kept, so Cyrillic, Greek, and Arabic titles resolve), then split on whitespace and punctuation. Each query word must start a word of the title or formal name, in any order; a word start includes CamelCase and letter–digit sub-words ("point" finds ChargePoint), never the middle of a word ("US" does not match Australia, "UK" does not match Ukraine). A separator-insensitive path ("J-1772", "U.K.") reaches exact and alias keys, and a leading "the" is optional. Matches rank in four tiers: curated alias (in its listed order), exact title / formal name / ISO code, every word a whole word of the entry, then word-start; ties break by ascending ID. This runs over the **complete** category set (not a page). Curated aliases are per category: connectors (`J1772`→Type 1 (1), `CCS`→both CCS (32, 33) with CCS Type 2 (33) ranked first, `CCS1`/`Combo 1`→32, `CCS2`/`Combo 2`→33, `Tesla`/`Supercharger`/`NACS`→27, `Type 2`→25/1036), charge levels (`fast`, `DC fast`, `DCFC`→3), and countries (`UK`, `Great Britain`, `Britain`, `England`, `Scotland`, `Wales`, `Northern Ireland`→GB; `USA`, `United States of America`→US; `Holland`→NL; `South Korea`→KR; `North Korea`→KP). No fuzzy fallback in v1 — on empty match, return zero matches with a recovery that says "browse the category with no query."

**Empty results:** success with `matches: []`, `totalCount: 0` and a notice echoing the query and suggesting spelling checks or browsing the category.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` (no external call — bundled data).

---

### `openchargemap_get_station_comments`

Community check-ins for one station — the honest reliability signal beyond the registry flag. Wraps `GET /v3/poi?chargepointid=<id>&includecomments=true`, extracting the embedded `UserComments[]`. (There is **no** standalone `/v3/comments` GET endpoint — verified 404; comments are only available embedded in the POI.) Returns the comments **plus** the registry status and last-verified date so the agent can directly compare claim vs. reports.

**Note on `maxresults` and `offset`:** OCM does not paginate the embedded `UserComments[]` array — one `/poi` call returns every comment a station has. The whole list is therefore resident before the handler touches it, so `offset`/`maxresults` are a direct slice of it (newest first) and `totalCount` is the exact comment count. Nothing is unreachable: paging costs no extra upstream calls.

**Description (final):**
> Read community check-ins and comments for one Open Charge Map station — the real-world reliability signal beyond the operator-reported registry status. Returns user comments and fault reports with ratings, dates, and the outcome the driver recorded ("Charged Successfully", "Failed to Charge (Equipment Not Operational)", …), alongside the station's current registry status and last-verified date, surfacing mismatches like "listed operational, but the last few check-ins report a fault." A busy station's check-ins come back one page at a time: when a page reports truncated, repeat the call with the reported nextOffset to read the next one.

**Input:**

```ts
z.object({
  id: z.number().int().positive()
    .describe('Numeric OCM station ID.'),
  maxresults: pageLimitSchema(100).default(25)
    .describe('Maximum comments to return, newest first. Max 100; larger values are clamped to 100.'),
  offset: z.number().int().min(0).default(0)
    .describe('Comments to skip before the returned page, for reading past a truncated result. Repeat the same call with the nextOffset value the previous one reported. Ordering is newest-first and stable, but a check-in posted between pages shifts what a later offset lands on.'),
})
```

**Output:**

```ts
z.object({
  stationId: z.number().describe('OCM station ID the comments belong to.'),
  stationTitle: z.string().describe('Station name, for context.'),
  registryStatus: z.string().optional().describe('Current registry operational status (operator-reported).'),
  registryStatusId: z.number().optional().describe('Registry status ID — the value the openchargemap_find_stations statustypeid filter takes. Absent when OCM has no status on record.'),
  isOperational: z.boolean().optional().describe('Whether the registry marks the station operational. Absent when the operational state is unknown. Compare against the comments below — they are the real-world check.'),
  dateLastVerified: z.string().nullable().optional().describe('ISO 8601 date the listing was last verified. null when never verified.'),
  comments: z.array(z.object({
    user: z.string().optional().describe('Commenter username. Absent for anonymous.'),
    commentType: z.string().optional().describe('Comment type (e.g. "General Comment", "Fault Report").'),
    checkinStatus: z.string().optional().describe('The visit outcome the driver recorded (e.g. "Charged Successfully", "Failed to Charge (Equipment Not Operational)"). Carries the result on check-ins that have no comment text. Absent when the visitor recorded no outcome.'),
    checkinStatusId: z.number().optional().describe('Numeric ID of the check-in outcome, stable across renames of its title.'),
    checkinStatusIsPositive: z.boolean().optional().describe('Whether the registry classes this outcome as a good visit. Absent when the outcome carries no verdict either way (e.g. "Did Not Visit Location") or when none was recorded.'),
    comment: z.string().optional().describe('Comment text.'),
    rating: z.number().nullable().optional().describe('User rating 1–5. null when not given.'),
    relatedUrl: z.string().optional().describe('Link the commenter attached. Absent when none was given.'),
    dateCreated: z.string().optional().describe('ISO 8601 timestamp the comment was posted.'),
  })).describe('The requested page of community comments, newest first — offset/maxresults applied. Empty with totalComments 0 means OCM has no check-ins for this station (absence of reports is not evidence the charger works); empty with a non-zero totalComments means the offset is past the last comment.'),
  totalComments: z.number().describe('Comments this station has on record — the whole set, before offset/maxresults selected the page in comments. reliabilityNote counts its fault ratio over this population, not over the page.'),
  reliabilityNote: z.string().optional().describe('A caveat when the registry status, verification age, coordinates, or comments suggest the listing may not reflect reality. Omitted when there is nothing to flag.'),
  attribution: z.string().describe('Attribution to Open Charge Map contributors and station data providers; license terms vary by provider.'),
})
```

`totalCount` (comments on record, before the page was taken) via `ctx.enrich.total(n)`; truncation via `ctx.enrich.truncated({ shown, cap })` and `nextOffset` on the enrichment block. Empty `comments` is a valid, non-error result (the station exists but has no check-ins) — the description states that absence ≠ "works." `format()` renders the status/verified header, each comment as `[{dateCreated}] {user} ({commentType}, ★{rating}): {comment}`, the `reliabilityNote` when present, then attribution.

**Errors:**

```ts
errors: [
  { reason: 'not_found', code: JsonRpcErrorCode.NotFound,
    when: 'OCM returned an empty result for the given numeric ID (HTTP 200 with []) — no such station.',
    recovery: 'Verify the numeric OCM ID. Find a valid station first with openchargemap_find_stations.' },
  { reason: 'upstream_unavailable', code: JsonRpcErrorCode.ServiceUnavailable, retryable: true,
    when: 'OCM returned a non-2xx response or timed out.',
    recovery: 'Retry after a short delay. If it persists, OCM may be rate-limiting or down.' },
  { reason: 'auth_failed', code: JsonRpcErrorCode.Unauthorized,
    when: 'OCM returned HTTP 401 or 403 — the API key is missing or invalid.',
    recovery: 'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org). This is a server configuration issue, not an input error.' },
]
```

> Note: empty comments is **not** an error — it returns `comments: []` with the station's status header. `not_found` fires only when the station itself doesn't exist.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`.

---

## Resources

### `skill://openchargemap-guide/SKILL.md`

The published guide combines connector and access checks, dated reliability evidence, and coverage gates into charger-selection workflows. It ships under root `skills/` and is served through the MCP Skills extension. Its filesystem path is anchored to the installed entry point so a client's working directory cannot redirect skill loading.

### `openchargemap://station/{id}`

The resource twin of `openchargemap_get_station`. Read-only, stable-by-URI, useful as injectable context for clients that support resources.

| Aspect | Decision |
|:-------|:---------|
| URI template | `openchargemap://station/{id}` — `id` is the numeric OCM station ID. |
| Params | `z.object({ id: z.string().regex(/^\d+$/).describe('Numeric OCM station ID.') })` |
| Handler | Calls `OpenChargeMapService.getPoi(id, { includeComments: true })`; throws `notFound` on the empty-array case. Returns the same record shape as `openchargemap_get_station`. |
| Pagination | None — single record. |
| `list()` | Not provided — there is no meaningful bounded "all stations" list (the corpus is ~200k and geo-scoped); discovery is `openchargemap_find_stations`. |
| Tool coverage | Fully covered by `openchargemap_get_station` — the resource is convenience only. |

---

## Domain Mapping

OCM v3 has two endpoints this server uses; reference data is bundled.

| Noun | OCM access | Tool(s) |
|:-----|:-----------|:--------|
| Stations (POI) — search | `GET /v3/poi?latitude=&longitude=&distance=&distanceunit=` (radius and bounding box) or `polyline=&distance=&distanceunit=KM` (route), then `&countrycode=&connectiontypeid=&minpowerkw=&operatorid=&usagetypeid=&levelid=&statustypeid=&maxresults=&compact=false&verbose=false&output=json` | `openchargemap_find_stations` |
| Stations (POI) — single | `GET /v3/poi?chargepointid=<id>&includecomments=<bool>&output=json` (numeric ID only; UUID lookup returns random results — not supported) | `openchargemap_get_station`, `openchargemap://station/{id}` |
| Comments / check-ins | **embedded in POI** via `&includecomments=true` → `UserComments[]` (no standalone `/v3/comments` GET — verified 404) | `openchargemap_get_station_comments`, `openchargemap_get_station` |
| Reference data | bundled snapshot of `GET /v3/referencedata` (`ConnectionTypes`, `Operators`, `UsageTypes`, `StatusTypes`, `CurrentTypes`, `ChargerTypes`, `Countries`) + optional startup refresh | `openchargemap_lookup_reference` (+ internal labeling) |

**OCM filter param names** (exact, for the service layer): `latitude`, `longitude`, `distance`, `distanceunit` (`KM`/`Miles`), `polyline` (an encoded polyline, route searches), `countrycode`, `connectiontypeid` (comma-joined for arrays), `operatorid`, `usagetypeid`, `levelid`, `minpowerkw`, `statustypeid`, `maxresults`, `chargepointid`, `includecomments`, `compact`, `verbose`, `output=json`. Array filters serialize as comma-separated values.

---

## Workflow Analysis

### Place name → nearest working CCS charger (the headline workflow)

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `openstreetmap_search_places` (openstreetmap server) | "Ballard, Seattle" → `{lat: 47.6685, lon: -122.387}` |
| 2 | `openchargemap_lookup_reference` | `category: "connectiontypes", query: "CCS"` → `connectiontypeid: [33, 32]` |
| 3 | `openchargemap_find_stations` | coordinates + `connectiontypeid: [33, 32]` + `minpowerkw: 50` → ranked nearby DC fast stations |
| 4 | `openchargemap_get_station_comments` | for the top candidate → confirm recent check-ins don't report a fault |

### Known station → full detail

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `openchargemap_get_station` | `id: 145452, includeComments: true` → every connector + reliability note |

`find_stations` is a single upstream call (the filtering is OCM-side), so no multi-call orchestration table is needed; the cross-server geocode step is the only "chain," documented in the description.

---

## Design Decisions

**Four tools, matching the idea's sketch — find / detail / resolve / comments.** Each maps to a distinct user goal and a distinct call shape. `find_stations` (search), `get_station` (detail), `lookup_reference` (offline ID resolution), `get_station_comments` (reliability). No consolidation under a `mode` enum: the inputs diverge sharply (a search takes coordinates+filters; detail takes one ID; resolve takes a category+name), and the reference-resolver is offline while the others are live — merging would obscure required-vs-optional inputs and the `openWorldHint` difference.

**Reference data is bundled, not fetched per request.** The POI filters take integer IDs, not names; resolving them is the grounding a smaller model needs. The reference sets are small and bounded (measured: 43 connection types, 974 operators, 250 countries, the rest single-digit/low-double-digit) and change rarely. Bundling a committed TS-const snapshot makes resolution offline and instant, removes a hard runtime dependency on `/referencedata`, and gives a fallback if that endpoint is unavailable. An **optional** startup refresh (`OPENCHARGEMAP_REFERENCE_REFRESH`, default off) keeps it from drifting without making every deployment depend on a live fetch. (Mirrors the bundled-dataset pattern in `reference-data-mcp-server`.)

**Geocoding composes with `openstreetmap`, not rebuilt here.** OCM searches by lat/long + distance, bbox, or polyline, never place names. The companion `openstreetmap` server already provides `openstreetmap_search_places`; `find_stations` documents the two-step explicitly and `invalid_location`'s recovery points at it. No geocoding code, no place-name input — keeps the surface coordinate-native and honest about the boundary.

**Reliability is surfaced as first-class output, not buried.** Registry `StatusType` can read "operational" while the charger is broken — the live probe confirmed a real station with status "Temporarily Unavailable" yet `IsOperational: true`, and "Unknown" (ID=0) carries **no** `IsOperational` field at all (the key is absent from the StatusType object, not null — verified). So: every station carries `status` + `isOperational` + `dateLastVerified`; `get_station` and `get_station_comments` compute a plain-prose `reliabilityNote` from observable facts (verification age, operational flag, fault-vs-positive comment counts); the `statustypeid` filter description warns the status is operator-reported and stale-prone. The note is honest signal — no synthetic confidence score (per the no-fabricated-signal rule), and it's omitted when there's nothing to flag.

**Comments come from the POI, not a comments endpoint.** `idea.md` assumed a `/v3/comments` feed; the live probe returned **404** for `GET /v3/comments`. Comments are only available embedded in the POI via `includecomments=true` (`UserComments[]`). `get_station_comments` is therefore backed by the same `/poi` call with `includecomments=true`, extracting and reshaping `UserComments`. This is the one material deviation from the idea sketch — the tool and its user goal are unchanged; only the backing endpoint differs.

**Empty results are modeled deliberately.** OCM returns HTTP 200 + `[]` for a non-existent `chargepointid` (verified for IDs in the normal range; very large IDs such as 9999999999 fall back to returning random stations — but those are not valid OCM IDs) — `get_station` / `get_station_comments` detect the empty array and throw `not_found` rather than returning a null record. For `find_stations`, an exhausted search with zero matches returns success with `stations: []`, `totalCount: 0`, a search echo and widen/relax guidance. A sentinel-confirmed upstream remainder stays explicitly partial. Reference misses return success with `matches: []`, a query echo and spelling/browse guidance. For `get_station_comments`, an existing station with no check-ins returns `comments: []` (not an error) — and the description states absence of reports is not evidence the charger works (don't fabricate reliability from missing data).

**403, not 401, for bad keys — mapped to `auth_failed`/Unauthorized.** The probe showed both missing and invalid keys return HTTP 403. The service maps 403 → an `auth_failed` contract error whose recovery names the env var and the free-signup path, framed as a server-config issue rather than agent input. (A missing key fails fast at startup via `parseEnvConfig`; the runtime 403 path covers a revoked/rotated key.)

**Heavy upstream sparsity → optional output fields.** OCM omits `NumberOfPoints`, `UsageCost`, `GeneralComments`, `UserComments`, `MediaItems` freely and nullifies connection fields (`PowerKW`, `Amps`, `Voltage`, `Quantity`, and reference `FormalName`/`IsDiscontinued`). Every such field is `.optional()` / `.nullable()` in the schemas, with descriptions stating that absence means "unknown," not a zero/false fact. Tests include a sparse-payload case.

**No DataCanvas.** Find/detail/resolve/comments is a discovery-and-record surface of categorical data (titles, IDs, addresses), not analytical rows an agent runs SQL over. Per the design skill's shape-not-size rule, it doesn't qualify — and a `canvas_id` with no `dataframe_query` tool would be dead output. Excluded.

**No write tools.** OCM accepts POI and comment submissions, but writes need moderation and add little agent value; read-only keeps the surface clean and annotations safe. Deferred.

**Naming.** `openchargemap_` prefix — the canonical brand, and it sits alongside the `open*` family of companion servers (`openstreetmap`, `openfoodfacts`, `openalex`, `openlibrary`). Not `ocm_` (opaque acronym). Display identity (`createApp` `title`, manifest `display_name`) is the hyphenated machine name `openchargemap-mcp-server` everywhere — never Title Case.

---

## Known Limitations

- **Registry status is operator-reported and can be stale.** The server surfaces `status` + `isOperational` + `dateLastVerified` + community comments so the agent can judge, but OCM cannot guarantee a charger flagged "operational" actually works. This is inherent to the data; the server's job is to make the uncertainty visible, not resolve it.
- **UUID lookup is not supported.** The OCM API does not support station lookup by UUID — passing a UUID to `chargepointid` returns 100 random stations. Station lookup requires a numeric OCM ID. UUIDs appear in output (useful as a stable cross-system identifier) but cannot round-trip back into a fetch.
- **No standalone comments endpoint.** Comments are only available embedded in the POI (`includecomments=true`); there is no way to query the comment stream independently of a station, and no global "recent fault reports across all stations" query.
- **Coordinate-native — no place-name search.** Place names must be geocoded externally (`openstreetmap_search_places`). The server intentionally does not geocode.
- **Connection-level power is frequently estimated or absent.** Many `PowerKW` values are OCM estimates ("kW power is an estimate based on the connection type" appears in connection comments) or null. `minpowerkw` filtering is only as good as the underlying data; treat power as approximate.
- **Reference snapshot vintage.** Bundled reference data is a point-in-time snapshot (`REFERENCE_SNAPSHOT_DATE`). New operators or connector types added to OCM after it won't resolve until the snapshot is refreshed or `OPENCHARGEMAP_REFERENCE_REFRESH` is enabled. Connector types are near-static; the operator list grows slowly. `snapshotDate` reports the vintage of whichever set is actually in memory, paired with `source` (`live` | `bundled`) — `/referencedata` publishes no dataset date, `Last-Modified`, or `ETag`, so a successful refresh is dated by the moment it succeeded, and a failed one keeps the bundle's date rather than drifting forward.
- **`maxresults` caps the page, not the corpus.** OCM ignores upstream offsets and publishes no match total. Every search requests 501 records: the first 500 form a fixed candidate pool; an additional sentinel only proves an upstream remainder and never enters normalization, local filters or counts. Pages share one ten-minute tenant cache entry independent of offset and page size. `totalCount` stays stable while cached, exact without a sentinel and a floor with one. The deepest usable offset is 499. The fixed pool increases bandwidth for the first small page but avoids overlapping refetches while paging. No byte cap changes the caller’s page size.
- **Paged results can shift between calls.** Every search orders its fixed candidate pool the same way each time — by distance from the search point (a box's center), or along a route by `routeDistance`, then `offRouteDistance`, with station ID breaking ties — so a page is a stable slice of the pool. A route search's upstream order is newest-first with no distances, so a route search that finds the pool full may be missing older stations anywhere along the route. But OCM is edited continuously and results are cached for ten minutes, so a station added or removed between two fetches of the same search can move what a later `offset` lands on. Ordering is stable; membership is not.

---

## API Reference

| Aspect | Notes |
|:-------|:------|
| Base URL | `https://api.openchargemap.io/v3` (override: `OPENCHARGEMAP_BASE_URL`) |
| Auth | `X-API-Key: <key>` header on every request. Missing/invalid → **HTTP 403**. |
| Output | Always `output=json`. Use `compact=false&verbose=false` for search results (includes expanded `ConnectionType`/`Operator`/`StatusType` objects the formatters need). For single-station detail (`get_station`), use `compact=false&verbose=true`. `verbose` only decides whether null-valued keys are sent: both responses carry every populated field. |
| POI search params | `latitude`,`longitude`,`distance`,`distanceunit`(`KM`/`Miles`),`polyline`,`countrycode`,`connectiontypeid`,`operatorid`,`usagetypeid`,`levelid`,`minpowerkw`,`statustypeid`,`maxresults`. A box is sent as its center and farthest-point radius, never as `boundingbox`; `minnumberofpoints` is not sent (OCM ignores it, so `minchargepoints` filters locally). |
| Route search | `polyline` (encoded) + `distance` + `distanceunit=KM`. OCM buffers the polyline by `distance`/200 degrees, planar, and reads an omitted unit as miles, so the server sends a widened `distance` in km and narrows the results to the requested corridor by true great-circle distance. The request target is capped at 8,177 bytes (OCM's 8,192-byte request line), which bounds the polyline. |
| Single POI | `chargepointid=<numeric>` ; `includecomments=true` to embed `UserComments[]` ; non-existent ID → HTTP 200 + `[]` |
| Reference data | `GET /v3/referencedata` → object keyed by `ConnectionTypes`,`Operators`,`UsageTypes`,`StatusTypes`,`CurrentTypes`,`ChargerTypes`,`Countries`,… (bundled, not fetched per request) |
| Array filters | Comma-separated values (e.g. `connectiontypeid=32,33`) — OR-matched by OCM |
| Distance | `AddressInfo.Distance` is returned in the requested `distanceunit`; `DistanceUnit` field is an OCM enum int (1=km) |

### Verified reference IDs (snapshot, for descriptions/aliases)

| Category | Notable IDs |
|:---------|:------------|
| Connection types | Type 1/J1772 = **1**, CHAdeMO = **2**, Type 2 socket = **25**, NACS/Tesla Supercharger = **27**, CCS (Type 1) = **32**, CCS (Type 2) = **33**, Type 2 tethered = **1036**, ChaoJi/CHAdeMO 3.x = **1044** |
| Current types | AC Single-Phase = **10**, AC Three-Phase = **20**, DC = **30** |
| Levels (ChargerTypes) | Low <2kW = **1**, Medium >2kW = **2**, High >40kW (fast) = **3** |
| Usage types | Public = **1**, Private-Restricted = **2**, Public-Membership Required = **4**, Public-Pay At Location = **5** |
| Status types | Unknown = **0** (IsOperational absent), Currently Available = **10** (automated), Currently In Use = **20** (automated), Temporarily Unavailable = **30** (`IsOperational: true`!), Operational = **50**, Partly Operational (Mixed) = **75**, Not Operational = **100**, Planned For Future Date = **150**, Removed (Decommissioned) = **200**, Removed (Duplicate) = **210** |

### Verified response field shapes

**POI (station)** — top-level: `ID`, `UUID`, `DataProviderID`, `OperatorID`, `UsageTypeID`, `StatusTypeID` (absent when no status set), `DateLastVerified` (nullable), `IsRecentlyVerified`, `NumberOfPoints` (often null), `UsageCost` (often null), `GeneralComments` (absent when none — key not always present), `DateLastStatusUpdate` (nullable), nested `OperatorInfo{ID,Title,WebsiteURL,…}`, `UsageType{ID,Title,IsPayAtLocation,IsMembershipRequired,IsAccessKeyRequired}` (null/absent when no usage type), `StatusType{ID,Title,IsOperational(absent for Unknown/ID=0),IsUserSelectable}` (**entire key absent** when OCM has no status — not always present), `SubmissionStatus{ID,Title}`, `DataProvider{ID,Title,WebsiteURL,License}`, `AddressInfo{ID,Title,AddressLine1,Town,StateOrProvince,Postcode,CountryID,Country{ISOCode,Title,ContinentCode},Latitude,Longitude,ContactTelephone1,AccessComments,RelatedURL,Distance(absent for route searches, which carry no distance),DistanceUnit(int enum: 1=KM, 2=Miles)}`, `DateCreated`, `Connections[]`, `MediaItems[]` (null/absent when none), `UserComments[]` (only with `includecomments=true`). **`verbose=true` sends keys that `verbose=false` leaves out when null:** `GeneralComments`, `MediaItems`, `UserComments`, `NumberOfPoints`, `UsageCost`, `DateLastConfirmed`, `OperatorsReference`, `ParentChargePointID`, `PercentageSimilarity`, `MetadataValues`, plus extra AddressInfo fields (`AddressLine2`, `ContactEmail`, `ContactTelephone2`). Populated values are present either way. `OperatorInfo.IsPrivateIndividual` is true only for operator 44 ("(Private Residence/Individual)"); the contact fields are withheld for it.

**Connection** — `ID`, `ConnectionTypeID`, `ConnectionType{ID,Title,FormalName(nullable)}`, `LevelID`, `Level{ID,Title,IsFastChargeCapable,Comments}`, `Amps`(nullable), `Voltage`(nullable), `PowerKW`(nullable), `CurrentTypeID`, `CurrentType{ID,Title,Description}`, `Quantity`(nullable), `Comments`(nullable).

**UserComment** — `ID`, `ChargePointID`, `CommentTypeID`, `CommentType{ID,Title}`, `UserName`(nullable), `Comment`, `Rating`(1–5, nullable), `DateCreated`.

**Reference entry (e.g. ConnectionType)** — `ID`, `Title`, `FormalName`(nullable), `IsDiscontinued`(nullable), `IsObsolete`(nullable). **Operator** — `ID`, `Title`, `WebsiteURL`(nullable), `Comments`, `PhonePrimaryContact`(nullable), `IsPrivateIndividual`, `ContactEmail`(nullable), `FaultReportEmail`(nullable). **Country** — `ID`, `Title`, `ISOCode`, `ContinentCode`.

---

## Attribution

Open Charge Map combines data from providers with different license terms. Stations expose `dataProviderId`, `dataProviderLicense`, and `isOpenDataLicensed` when supplied; missing terms remain unknown. No implicit `opendata` filter removes stations. The text output of a search lists each provider's terms once per page in a closing `Data providers:` block keyed by provider ID, not by title (titles are not unique: two providers can share one with different terms). Placement:

1. **Every tool output** carries an `attribution` string: `"Station data © Open Charge Map contributors and the providers named on each station (openchargemap.org). License terms vary by provider."`
2. **README** carries a visible attribution + license note, like other attribution-required open-data servers (`openstreetmap`, `openfoodfacts`).
3. **Server `instructions`** (the `createApp` session-level field) may restate the attribution requirement once so clients surface it without reading every tool description.

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-06-13 | Four tools: `find_stations`, `get_station`, `lookup_reference`, `get_station_comments` | Matches the four distinct user goals (search / detail / offline ID resolution / reliability). Inputs and `openWorldHint` diverge too much to consolidate under a `mode` enum. |
| 2026-06-13 | Bundle reference data as a committed TS-const snapshot + optional startup refresh (`OPENCHARGEMAP_REFERENCE_REFRESH`, default off) | Sets are small and bounded (43 connection types, 974 operators, 250 countries, rest tiny — verified live) and change rarely. Bundling makes resolution offline/instant, drops a hard runtime dep on `/referencedata`, and provides a fallback. Optional refresh prevents drift without forcing a live fetch on every deploy. |
| 2026-06-13 | `get_station_comments` backed by `/poi?includecomments=true`, not `/comments` | `GET /v3/comments` returns **404** (verified) — there is no standalone comments endpoint. Comments are embedded in the POI as `UserComments[]`. The tool's user goal is unchanged; only the backing endpoint differs from `idea.md`. |
| 2026-06-13 | Surface `status` + `isOperational` + `dateLastVerified` + a plain-prose `reliabilityNote` on detail/comments | Registry status lies — verified a station reading "Temporarily Unavailable" with `IsOperational: true`, and "Unknown" (ID=0) → `IsOperational` **absent** (not null — the key is missing from the StatusType object). Making the mismatch visible is the server's core value. Note is honest prose from observable facts; no synthetic confidence score. |
| 2026-06-13 | `auth_failed` contract error mapped from HTTP 403 (not 401) | Verified both missing and invalid keys return 403. Recovery names `OPENCHARGEMAP_API_KEY` and the free-signup path; framed as server config, not agent input. Missing key also fails fast at startup via `parseEnvConfig`. |
| 2026-08-06 | `auth_failed` contract `when` text widened to "HTTP 401 or 403" — a follow-up to the 2026-06-13 row above, which stands as recorded | A re-probe on this date confirms the original finding: OCM answers a missing, empty, or invalid key with **403 only** — six sequential attempts, both `/poi` and `/referencedata`, five malformed key shapes, no 401 observed. The body distinguishes the two cases (`Invalid API key.` for a key that does not resolve; `You must specify an API key using the key query parameter or x-api-key header.` for an absent or empty one), but the status is 403 either way. The prose changed anyway because `translateFetchError()` maps **both** `Unauthorized` (401) and `Forbidden` (403) to `auth_failed`, so 401 sits inside the declared failure surface even though the live upstream does not emit it. This closes a contract-vs-code gap — a 401 from OCM or any edge in front of it already surfaces as `auth_failed` — and records no change in upstream behavior. |
| 2026-08-06 | Unreadable `/v3/poi` bodies reject the whole response rather than discarding the bad rows | Invalid JSON, a non-array body, and an array carrying a non-object member all throw the declared `upstream_unavailable` envelope from inside the fetch error boundary, where a raw `SyntaxError`/`TypeError` previously escaped. Whole-response rejection matches the non-array case already handled there and stops a partially-corrupt body from surfacing as a short but plausible station list. The member guard tests object-ness only — OCM omits most fields on legitimately sparse records, so a stricter shape check would reject real stations. Accepted cost: an unreadable member now fails inside the retry boundary, so it burns the full 4-attempt budget (~11s) where the escaping `TypeError` failed on the first call — the same budget the non-array case has always spent, and a path 15 live probes across 2,271 array members never reached. |
| 2026-06-13 | Non-existent station (HTTP 200 + `[]`) → `not_found`; existing station with no comments → `comments: []` (not an error) | OCM signals "no such station" with an empty array, not a 404 — the handler must detect it. Distinguishing "doesn't exist" from "exists, no check-ins" matters: the latter must not be reported as missing, and absence of reports ≠ "works." |
| 2026-06-13 | Global by default; `countrycode` optional, no implicit country | Coverage is worldwide; a hardcoded country (esp. US) would silently break non-US queries. Return country + operator on each result so multi-region queries stay legible. |
| 2026-06-13 | All sparse/nullable upstream fields modeled `.optional()` with "absence = unknown" descriptions; truncation fields on the enrichment block only | OCM omits/nullifies fields heavily (verified: `NumberOfPoints`, `UsageCost`, comments, media, connection power/amps/voltage; `StatusType` key itself can be absent from some POI records). Required truncation fields would throw `-32007` on every non-truncated result; `ctx.enrich.truncated()` populates them only when the cap is hit. `totalCount` stays required via `ctx.enrich.total()`. |
| 2026-06-13 | `getPoi` (detail) uses `verbose=true`; `searchPois` uses `verbose=false` | `verbose` only decides whether null-valued keys are sent; a populated `GeneralComments`, `UsageCost`, `NumberOfPoints`, `MediaItems`, or extra AddressInfo field (`AddressLine2`, `ContactEmail`, `ContactTelephone2`) comes back either way. The search method stays `verbose=false` for payload efficiency; the detail method uses `verbose=true` to receive the full record. |
| 2026-06-13 | UUID input removed from `get_station` and `get_station_comments`; `id` is numeric only | Verified that passing a UUID string as `chargepointid` returns 100 random stations (a default listing), not the matching station. No UUID-to-numeric lookup param exists. All tools accept numeric OCM IDs only; the UUID field is exposed in output for reference but cannot be used as lookup input. |
| 2026-06-13 | Coordinate-native; geocoding via `openstreetmap_search_places`, not rebuilt | OCM is coordinate-only. The companion `openstreetmap` server already provides geocoding; documenting the two-step keeps the boundary honest and the surface small. |
| 2026-06-13 | `lookup_reference` resolves via strict token match over the full bounded set + curated connector aliases; no fuzzy fallback in v1 | The bounded-set name→opaque-ID pattern (MCP-side list filtering). Strict normalized token match is the ~90% case; aliases (`J1772`, `CCS`, `Supercharger`/`NACS`, `Type 2`) cover the connectors agents actually name. On empty match, recovery says "browse the category" rather than guessing — lets the model self-correct. |
| 2026-10-25 | Descriptions give CCS as both IDs (`[32, 33]`), never 33 alone; alias ranking unchanged | Open Charge Map tags North American CCS as Type 1 (32) and European CCS as Type 2 (33). The earlier `"CCS" → 33` example led US callers to a filter that matches nothing (Portland, 15 km: 33 → 0 stations, 32 → 65). The lookup already returned both IDs, so the fix is the guidance: pass every returned ID as an array. A region-aware ranking was rejected because the lookup has no coordinates, and guessing a region would hide the other variant. |
| 2026-06-13 | No DataCanvas, no write tools, one resource (`openchargemap://station/{id}`) | Discovery/record surface, not analytical rows (shape-not-size). Writes need moderation, defer. The single resource is the detail tool's convenience twin; no reference resource (it's a resolve surface, not a stable-by-URI record). |
| 2026-10-25 | Provider-specific licensing in station records, contributor and provider attribution on every output | OCM combines differently licensed sources. Preserve each provider's license text and explicit open-data flag rather than implying one license covers every station; no default filter silently removes stations. |
| 2026-06-13 | Display identity = hyphenated machine name `openchargemap-mcp-server` everywhere | Fleet rule — `createApp` `title`, manifest `display_name`, docs headers all use the machine name; Title Case is a known agent failure mode. `description` derives from package.json (not duplicated into the identity block). |
| 2026-11-19 | `get_station` withholds all six contact fields (`contactPhone`, `contactPhoneSecondary`, `relatedUrl`, `operatorWebsite`, `operatorPhone`, `operatorFaultReportEmail`) when `OperatorInfo.IsPrivateIndividual` is true | Only operator 44 ("(Private Residence/Individual)") carries the flag, and its records hold a household's phone or email. Dropping them at the normalizer keeps a private person's contact details out of both output surfaces. |
| 2026-11-19 | Search text lists provider license terms once per page in a closing `Data providers:` block keyed by provider ID | A page of stations from one provider repeated identical license text per row. Titles are not unique (six duplicate provider titles, e.g. Petite Borne with IDs 62 and 120, carry different terms), so the ID is the key; a station whose terms differ from the entry already listed under its ID keeps its terms inline, so no station's license drops out of the text. |
| 2026-11-19 | `lookup_reference` matches by word start with four ranked tiers (alias, exact, whole words, word start), per-category aliases, and a Unicode-aware fold; no query length cap | Substring matching put Ukraine beside the UK and Australia under "US"; an ASCII-only fold made Cyrillic, Greek, and Arabic operator titles unfindable. Aliases cover connectors, countries, and charge levels because agents name all three. Matcher cost is linear in query length, and a cap would reject queries that resolve correctly. |
| 2026-11-19 | A bounding box is searched as a radius from its center out to its farthest point, then narrowed to the box locally; OCM's `boundingbox` parameter is not sent | OCM evaluates `boundingbox` as a geodesic polygon whose east–west edges bow poleward, so it returns stations outside a wide box, misses some inside it, and reads a box crossing ±180° as its complement. Searching from the center also gives every station a distance and a nearest-first order. |
| 2026-11-19 | The search radius sent to OCM is scaled by 6378.1/6371 | OCM reports distances over a 6371 km Earth but hands its search distance to MongoDB's `$nearSphere`, which converts it over 6378.1 km. Sent as-is, a radius reaches 0.11% short of itself and omits stations OCM reports just inside it. |
| 2026-11-19 | A truncated radius or box search reports how far the pool reaches; for a box the clause names its farthest point, not a corner | The reach is the farthest retrieved record, floored so it never claims coverage past one. A box wider than 180° is farthest at the midpoint of an east or west edge (a turning point of the great-circle distance), not at a corner, so "corner" would be wrong. |
| 2026-11-19 | Pool order breaks distance ties by ascending station ID | Co-located stations share a distance; the tie-break keeps a refetched pool in the order earlier pages were cut from. |
| 2026-11-19 | A permanent upstream rejection (an HTTP status the same request will get again, such as 400, 404, 414, or 422) is not retried; the retry ladder shares one 50 s deadline | A request OCM refuses gets the same refusal again, so retrying burns the ladder for nothing; the recovery tells the caller to change the inputs. The 50 s deadline ends the ladder before a 60 s client gives up, and an exhausted ladder is the same retryable `upstream_unavailable`. |
| 2026-11-19 | Upstream `Retry-After` paces retries and reaches the caller as `data.retryAfter` | A rate-limited OCM states how long to wait; honoring it beats the fixed ladder. A wait longer than the ladder allows fails at once, with the wait reported. |
| 2026-11-19 | Search drops records inside the 1° square around 0,0; `get_station` flags such coordinates as a placeholder | OCM stores unlocated records at or a few metres off 0,0. The 1° square is open ocean (the nearest land, São Tomé, is 6.5° east), so no station stands in it, while single-axis zeros such as the equator through Kampala stay real. |
| 2026-11-19 | Route search is OCM's `polyline` search with a widened `distance` in km, narrowed locally by great-circle distance to the route | OCM buffers the polyline by `distance`/200 degrees, planar, which is not a corridor of `distance` km (at 47° N a 5 km buffer reaches 2.8 km north and 1.9 km east), and reads an omitted unit as miles. The server sends the buffer that covers the corridor everywhere, then keeps stations within `distance` of the route and computes each one's `routeDistance` and `offRouteDistance`. |
| 2026-11-19 | Route searches refuse a corridor that would cross a pole or ±180° rather than clip it; legs spanning 180° of longitude or more are refused | OCM returns an empty body past a pole and silently drops on-route stations past ±180°, either of which reads as "no stations". A planar buffer wraps a 180°+ leg around the globe. The refusal names the widest distance that fits, or the split to make. |
| 2026-11-19 | A route search that runs out the 15 s request timeout is not retried | The same route asks the same of OCM again, so a retry would end the same way and only delay the answer; the caller gets the next move (fewer points, or a stretch searched with a center or a box) at once. Other route failures retry as in every mode. |
| 2026-11-19 | The route corridor's widening allows for corner chords on routes of three or more points | OCM's buffer rounds a turn with a whole number of segments, so one corner chord can span up to 1.5 of its quarter-circle steps and cut further inside the requested width than a cap's chords do. The widening divides by cos(3π/8n) instead of cos(π/4n) once a route has a corner. |
| 2026-11-19 | A route request is capped at an 8,177-byte target, checked before sending | OCM's server takes an 8,192-byte request line, which leaves 8,177 bytes for the path and query (8,177 returns 200, 8,178 returns 414). Only the polyline can grow a request that long, so the refusal asks for fewer points. |
| 2026-11-19 | Route `routeDistance`/`offRouteDistance`, and search `distance` in every mode, are rounded to hundredths in `structuredContent`; the pool sorts on the rounded values | `structuredContent` and the rendered text carry the same value, and a page's order never contradicts the numbers beside it. |

---

## Review pass

**Reviewer:** independent design review, 2026-06-13. All claims below were verified against the live OCM v3 API using the provisioned key.

### Changes made

| # | What changed | Why |
|:--|:-------------|:----|
| 1 | **UUID input removed from `get_station` and `get_station_comments`** (`id` is numeric only) | Verified: passing a UUID string as `chargepointid` returns 100 random stations — a default listing fallback, not a UUID-matched result. The OCM API has no UUID lookup parameter. The `id` input is now `z.number().int().positive()` with a note that UUID lookup is unsupported. UUID remains in output fields as a stable identifier. |
| 2 | **MCP Surface table updated** — removed "or UUID string" from `get_station` and `get_station_comments` key inputs | Cascade from #1. |
| 3 | **Requirements section updated** — added UUID limitation note to single-station detail bullet | Cascade from #1. |
| 4 | **Domain Mapping section updated** — removed "or UUID-search param" from single POI row | Cascade from #1. |
| 5 | **Known Limitations section** — added UUID lookup limitation entry | Makes the limitation visible at the server level, not buried in tool detail. |
| 6 | **Error contracts updated** — "ID/UUID" phrasing replaced with "numeric ID" in `not_found` recovery messages | Accuracy; also removes false suggestion that UUID can be corrected and retried. |
| 7 | **`StatusType.IsOperational` for Unknown changed from `.nullable()` to `.optional()`** | Verified: for Unknown (StatusType ID=0), the OCM API omits `IsOperational` entirely from the StatusType object — the key is absent, not null. The design doc previously stated `IsOperational: null`, which was wrong. Changed throughout: output schemas for `find_stations` and `get_station_comments`, Design Decisions, and Decisions Log. |
| 8 | **`StatusType` key itself can be absent** from POI records | Verified: station 253415 (London) has no `StatusType` key at all in the response (neither the key nor a null value). Noted in Requirements sparse-fields line, implementation order tests note, and API Reference response-shapes section. |
| 9 | **`DistanceUnit` in response is an integer enum** (1=KM, 2=Miles), not a string | Verified: `AddressInfo.DistanceUnit` is `1` for KM and `2` for Miles requests. The output schema `distanceUnit` field description updated to clarify the service layer normalizes this to the string enum. |
| 10 | **Status type table completed** — added missing IDs 75, 150, 200, 210 | Verified from `/v3/referencedata`: `Partly Operational (Mixed)=75`, `Planned For Future Date=150`, `Removed (Decommissioned)=200`, `Removed (Duplicate Listing)=210`. Also corrected `Unknown=0` to note `IsOperational` is absent (not null). |
| 11 | **`UsageType` extra fields documented** — `IsPayAtLocation`, `IsMembershipRequired`, `IsAccessKeyRequired` | Verified: `UsageType` object in response includes these three boolean fields. Added to `find_stations` output schema and API Reference response shapes. |
| 12 | **Detail calls use `verbose=true`** | `verbose=true` sends keys that `verbose=false` omits when null; populated values are present either way. Updated Services section (`getPoi` uses `verbose=true`), `get_station` output descriptions, and API Reference Output row. Decisions Log entry added. |
| 13 | **`get_station_comments` `maxresults` behavior clarified** | The OCM API returns all embedded `UserComments[]` via `includecomments=true` — there is no server-side comment pagination. The handler trims to `maxresults` client-side. Added a "Note on `maxresults`" block to the tool detail section. |
| 14 | **Large-int ID fallback behavior noted** | Verified: very large IDs (e.g., 9999999999) cause the OCM API to return a 100-item default listing rather than `[]`. IDs in the normal numeric range (up to ~9 digits) correctly return `[]` for non-existent stations. Not-found detection by empty array is correct for realistic usage. Noted in Design Decisions empty-results entry. |

### Non-changes (confirmed correct)

- `/v3/comments` endpoint returns 404 — the design's decision to use `includecomments=true` on the POI is correct.
- `X-API-Key` header required; both missing and invalid keys return HTTP 403 (not 401). `auth_failed` error code and Unauthorized mapping are correct.
- OCM's own `boundingbox` parameter is not used: it evaluates a geodesic polygon, so the server searches a box as a radius from its center and narrows the results to the box (see Decisions Log).
- `minchargepoints` is the user-facing input; OCM's `minnumberofpoints` is ignored upstream, so the server filters on it locally and does not send it.
- Truncation via `ctx.enrich.truncated()` on enrichment block (not required output fields) — correct per the recurring `-32007` bug pattern.
- `totalCount` via `ctx.enrich.total()` — correct.
- Identity: `createApp` `name`=`title`=`openchargemap-mcp-server`; `description` from package.json only (not duplicated into identity block) — correct.
- Reference data counts from live API: ConnectionTypes=43, Operators=974, Countries=250, StatusTypes=10, UsageTypes=8, ChargerTypes=3, CurrentTypes=3 — match the design's service layer description.
- Verified reference IDs (connector types, current types, levels, usage types) in API Reference table are accurate.
