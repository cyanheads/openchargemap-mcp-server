# openchargemap-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openchargemap_find_stations` | The workhorse. Find EV charging stations near a point (lat/long + distance) or within a bounding box, optionally scoped to a country. Filter by connector type, minimum power, operator/network, usage (public/free/membership), operational status, and minimum charge points. Coordinate-native — geocode a place name with `openstreetmap_geocode` first. Returns each station's title, address, distance, connections (type/power/count), operator, access, operational status, and last-verified date. | `latitude`+`longitude`+`distance` OR `boundingbox`; `countrycode?`, `connectiontypeid?`, `minpowerkw?`, `operatorid?`, `usagetypeid?`, `levelid?`, `statustypeid?`, `minchargepoints?`, `maxresults?` | `readOnlyHint: true`, `openWorldHint: true` |
| `openchargemap_get_station` | Full detail for one station by OCM numeric ID: every connection (type, level, power, current, quantity, status), operator + network, usage restrictions (pay/membership/access key), number of points, general comments, usage cost, data provider, media, and verification recency. Includes community check-ins inline. | `id` (numeric OCM ID); `includecomments?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `openchargemap_lookup_reference` | Resolve Open Charge Map reference data → the integer IDs `find_stations` filters require. Turns "CCS", "CHAdeMO", "Tesla Supercharger", "Type 2", an operator name ("ChargePoint", "Tesla"), a usage type, a status, a current type, or a country name/code into its `connectiontypeid` / `operatorid` / `usagetypeid` / etc. Bundled and cached — offline, no network round trip. Browse a full category with no query. | `category` (enum), `query?` (name/code to resolve), `limit?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `openchargemap_get_station_comments` | Community check-ins and comments for one station — the honest reliability signal. Returns user-reported comments and fault reports with ratings and dates, plus the station's registry operational status and last-verified date so an agent can flag "listed operational, but recent check-ins report a fault." | `id` (numeric OCM ID); `maxresults?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `openchargemap://station/{id}` | Full station record by OCM numeric ID — the resource twin of `openchargemap_get_station`. | None — single record |

Resources are supplementary. All data is fully reachable through tools — the resource is a convenience for clients that support injectable context by stable URI. Reference data is **not** exposed as a resource (it is a query/resolve surface, not a stable-by-URI record; `openchargemap_lookup_reference` covers it).

### Prompts

None. The surface is find / detail / resolve — data-and-lookup oriented, no recurring multi-step interaction pattern that a prompt template would structure. (The route-planning "moonshot" in `idea.md` would warrant one, but it is explicitly out of scope for v1.)

---

## Overview

Global electric-vehicle charging as one find-and-detail server over **Open Charge Map** (OCM) — the community-maintained, nonprofit registry of public charging stations worldwide (~200k+ locations across Europe, North America, Asia, and Oceania). Find chargers near a point or within a region, filtered by connector, power, and network; pull full station detail; resolve the connector/operator reference data those filters key on; and read community check-ins for real-world reliability.

A companion `openstreetmap` MCP server already covers geocoding and places, but nothing covers the EV-charging layer that rides on top of it. OCM is the canonical open registry — global, crowd-verified, CC BY 4.0 — and "where can I charge near here, with the right connector, that actually works" is a real, recurring query. It composes directly with `openstreetmap` (geocode a place → coordinate search).

**Audience:** EV drivers and trip-planning assistants, mobility and fleet-management tooling, mapping and travel agents — anyone resolving "nearest working charger for this car" anywhere in the world.

**Scope:** Read-only v1. Global by default — country is an optional filter, never a hardcoded default. No DataCanvas (find/detail/resolve surface, not analytical rows). Attribution (CC BY 4.0) mandatory.

---

## Requirements

- **POI geo-search** via OCM `/v3/poi` by radius (`latitude` + `longitude` + `distance`) or bounding box (`boundingbox`), optionally scoped by `countrycode`, with filters: `connectiontypeid`, `minpowerkw`, `operatorid`, `usagetypeid`, `levelid`, `statustypeid`, `minchargepoints`.
- **Single-station detail** via OCM `/v3/poi?chargepointid=<id>` (numeric only; UUID lookup is not supported by the API — passing a UUID as `chargepointid` returns 100 random stations) — full connection/operator/usage breakdown, comments inline when requested.
- **Reference-data resolution** — friendly name → integer filter ID, served from a bundled snapshot (offline, zero-latency), refreshed on startup with the snapshot as fallback.
- **Community reliability** — user comments/check-ins (embedded in the POI via `includecomments=true`) plus `DateLastVerified` and registry `StatusType`, surfaced together so registry-vs-reality mismatch is visible.
- **Coordinate-native** — the server does not geocode place names; document the `openstreetmap_geocode` two-step in `find_stations`' description.
- **Auth:** OCM requires an `X-API-Key` request header on every endpoint (`/poi`, `/referencedata`). Key is free (instant signup). A missing or invalid key returns **HTTP 403**.
- **Rate limits:** generous community limits, no hard published number — be polite: cache reference data, default `maxresults` modestly, enforce session-level caching in the service.
- **Global coverage**, read-only, no writes (OCM accepts POI/comment submissions but writes need moderation and add little agent value → deferred).
- **Attribution:** CC BY 4.0. Credit "Open Charge Map" + contributors in README and in every tool's output metadata (`attribution` field).

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenChargeMapService` | OCM POI API (`/v3/poi`) — live charging-station + embedded-comment data; HTTP client with retry + session-level `ctx.state` caching | `openchargemap_find_stations`, `openchargemap_get_station`, `openchargemap_get_station_comments`, `openchargemap://station/{id}` |
| `ReferenceDataService` | Bundled OCM reference snapshot (`src/data/ocm-reference-data.ts`) + optional startup refresh from `/v3/referencedata`; builds name→ID indices per category | `openchargemap_lookup_reference`; consulted by `find_stations` to label resolved filters and by detail/find formatters to name IDs |

**`OpenChargeMapService`** — stateless HTTP client. One method per tool need: `searchPois(params)`, `getPoi(id, { includeComments })`. Sets `X-API-Key` from config on every request, always `output=json&compact=false`. **Search** uses `verbose=false` (sufficient for the fields `find_stations` exposes). **Detail** (`getPoi`) uses `verbose=true` so that `GeneralComments`, `UsageCost`, `NumberOfPoints`, `MediaItems`, and full `AddressInfo` fields are present — these are absent or null in `verbose=false` responses. `withRetry` wraps the full fetch+parse pipeline; backoff calibrated for a rate-limited upstream (base ~1–2s). Session-level result cache in `ctx.state` keyed by the full param set (TTL ~10 min — station status changes but not second-to-second).

**`ReferenceDataService`** — init/accessor. At `setup()`:
1. Load the bundled snapshot (a TS const committed to the repo, captured from `/v3/referencedata`) — this is the source of truth and the offline fallback.
2. **Optionally** refresh from the live `/v3/referencedata` endpoint (gated by `OPENCHARGEMAP_REFERENCE_REFRESH`, default off): on success, replace the in-memory set; on any failure, log a warning and keep the bundled snapshot. Never let a refresh failure block startup.
3. Build per-category lookup indices: exact-ID map, normalized-title map, and (for connection types) a `FormalName` + common-alias map so "J1772" → Type 1, "Supercharger" → NACS, etc.

Reference sets are small and bounded (measured live: ConnectionTypes 43, Operators 974, Countries 250, CurrentTypes 3, ChargerTypes/levels 3, StatusTypes 10, UsageTypes 8, plus CheckinStatusTypes 18, UserCommentTypes 5, DataProviders 53) — total well under 1 MB. Bundling beats a hard runtime dependency on the reference endpoint; the optional refresh keeps it from drifting.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OPENCHARGEMAP_API_KEY` | **Yes** | OCM API key, sent as the `X-API-Key` header on every request. Free instant signup at openchargemap.org. Startup fails fast with a `ConfigurationError` banner if unset. |
| `OPENCHARGEMAP_BASE_URL` | No | Override the OCM API base (default `https://api.openchargemap.io/v3`). For a private mirror or testing. |
| `OPENCHARGEMAP_REFERENCE_REFRESH` | No | `z.stringbool()`, default `false`. When `true`, refresh reference data from `/v3/referencedata` at startup, falling back to the bundled snapshot on failure. When `false`, use the bundled snapshot only (fully offline). |

`server-config.ts` is a lazy-parsed Zod schema separate from framework config; `parseEnvConfig` maps schema paths → env var names so errors name `OPENCHARGEMAP_API_KEY`, not `apiKey`. Use `z.stringbool()` for the boolean (never `z.coerce.boolean()`).

> **Wiring note:** the env var is exactly `OPENCHARGEMAP_API_KEY`. It must appear in `server-config.ts`, `server.json` (`environmentVariables[]`), `manifest.json` (`mcp_config.env` + `user_config`), `.claude-plugin/plugin.json`'s `mcpServers` env block, and `.codex-plugin/mcp.json` — `lint:packaging` cross-checks `server.json` ↔ `manifest.json`.

---

## Implementation Order

1. **Config + server setup** — `server-config.ts` with the three env vars; wire `createApp({ name: 'openchargemap-mcp-server', title: 'openchargemap-mcp-server', websiteUrl: '<repo>', tools: […] })`. Do **not** pass `description`/`websiteUrl` duplicates of package.json into the identity block beyond `websiteUrl`; `description` derives from package.json.
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

The workhorse. Wraps `GET /v3/poi`. Coordinate-native; place names geocode through `openstreetmap_geocode` first (documented in the description, not implemented here).

**Description (final):**
> Find EV charging stations from the global Open Charge Map registry near a point or within a bounding box. Provide either a center (`latitude` + `longitude` + `distance`) or a `boundingbox`; optionally scope to a country with `countrycode`. This tool is coordinate-native and does not geocode place names — resolve a place like "Ballard, Seattle" to coordinates with `openstreetmap_geocode` first, then pass them here. Filter by connector type, minimum power (kW), operator/network, usage type (public/free/membership), charge level, operational status, and minimum charge points. Filter IDs are integers — resolve a connector or network name to its ID with `openchargemap_lookup_reference` (e.g. "CCS" → 33). Each result includes title, address, distance from the search point, connections (type, power, count), operator, access rules, registry operational status, and the last-verified date — treat an old `dateLastVerified` or a non-operational status as a reliability caveat.

**Input:**

```ts
z.object({
  // --- Location: radius OR bbox (validated in handler: exactly one mode) ---
  latitude: z.number().min(-90).max(90).optional()
    .describe('Center latitude (WGS84 decimal degrees). Use with longitude + distance for a radius search. Resolve place names via openstreetmap_geocode first.'),
  longitude: z.number().min(-180).max(180).optional()
    .describe('Center longitude (WGS84 decimal degrees). Use with latitude + distance for a radius search.'),
  distance: z.number().positive().max(500).default(25)
    .describe('Search radius from the center point, in the unit given by distanceUnit (default km). Max 500. Keep small (5–25) for dense urban areas; widen for rural coverage.'),
  distanceUnit: z.enum(['KM', 'Miles']).default('KM')
    .describe('Unit for the distance parameter and the returned distance values.'),
  boundingbox: z.object({
    sw_lat: z.number().min(-90).max(90).describe('South-west corner latitude.'),
    sw_lng: z.number().min(-180).max(180).describe('South-west corner longitude.'),
    ne_lat: z.number().min(-90).max(90).describe('North-east corner latitude.'),
    ne_lng: z.number().min(-180).max(180).describe('North-east corner longitude.'),
  }).optional()
    .describe('Bounding-box search as an alternative to a center+radius. Serialized to OCM as (sw_lat,sw_lng),(ne_lat,ne_lng). Mutually exclusive with latitude/longitude/distance.'),

  // --- Scope + filters (all optional; integer IDs resolve via openchargemap_lookup_reference) ---
  countrycode: z.string().length(2).regex(/^[A-Za-z]{2}$/).optional()
    .describe('Restrict to one country by ISO 3166-1 alpha-2 code (e.g. "US", "FR", "GB"). Omit for a global search. The server is global by default — there is no implicit country.'),
  connectiontypeid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).max(10)]).optional()
    .describe('Connector type ID, or an array of IDs (OR-matched). Resolve names with openchargemap_lookup_reference — e.g. CCS (Type 2)=33, CHAdeMO=2, NACS/Tesla Supercharger=27, Type 2 socket=25, Type 1/J1772=1.'),
  minpowerkw: z.number().positive().max(1000).optional()
    .describe('Minimum charging power in kW across any connection at the station. Use ~50 for DC fast charging, ~150 for high-power DC. Stations whose fastest connection is below this are excluded.'),
  operatorid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).max(10)]).optional()
    .describe('Operator/network ID, or array of IDs (OR-matched). Resolve a network name with openchargemap_lookup_reference (category "operators") — e.g. "Tesla", "ChargePoint".'),
  usagetypeid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).max(10)]).optional()
    .describe('Usage/access type ID, or array (OR-matched). Resolve via openchargemap_lookup_reference (category "usagetypes") — e.g. Public=1, Public-Pay At Location=5, Public-Membership Required=4.'),
  levelid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).max(3)]).optional()
    .describe('Charge level ID (1=Low <2kW, 2=Medium >2kW, 3=High >40kW/fast). Array OR-matched. Use 3 as a coarse "fast charging only" filter when a specific connector is not required.'),
  statustypeid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).max(10)]).optional()
    .describe('Registry operational-status ID, or array (OR-matched). Resolve via openchargemap_lookup_reference (category "statustypes"). NOTE: registry status is operator-reported and can be stale — combine with dateLastVerified and openchargemap_get_station_comments to judge real-world reliability, do not treat it as ground truth.'),
  minchargepoints: z.number().int().positive().optional()
    .describe('Minimum number of charge points (stalls) at the station. Filters out single-point locations when you need a station likely to have an open stall.'),

  maxresults: z.number().int().min(1).max(200).default(25)
    .describe('Maximum stations to return, ordered by distance from the search point. Max 200. Larger values cost more payload and upstream load — prefer tightening filters over raising this.'),
})
```

**Output:**

```ts
z.object({
  stations: z.array(z.object({
    id: z.number().describe('OCM station ID. Pass to openchargemap_get_station or openchargemap_get_station_comments.'),
    uuid: z.string().describe('OCM station UUID — stable cross-system identifier.'),
    title: z.string().describe('Station name / location title.'),
    address: z.object({
      line1: z.string().optional().describe('Street address line.'),
      town: z.string().optional().describe('Town or city.'),
      stateOrProvince: z.string().optional().describe('State or province.'),
      postcode: z.string().optional().describe('Postal/ZIP code.'),
      country: z.string().optional().describe('Country name.'),
      countryCode: z.string().optional().describe('ISO 3166-1 alpha-2 country code.'),
      latitude: z.number().describe('Station latitude (WGS84).'),
      longitude: z.number().describe('Station longitude (WGS84).'),
      accessComments: z.string().optional().describe('Free-text access notes (e.g. "24 hours daily").'),
    }).describe('Structured station address and coordinates.'),
    distance: z.number().optional().describe('Distance from the search point. Absent for bounding-box searches.'),
    distanceUnit: z.enum(['KM', 'Miles']).optional().describe('Unit of the distance value (normalized from OCM integer: 1=KM, 2=Miles). The service layer converts the raw integer to this string for clarity.'),
    operator: z.string().optional().describe('Operating network name (e.g. "ChargePoint", "Tesla"). Absent when OCM has no operator on record.'),
    operatorId: z.number().optional().describe('OCM operator ID — resolve names via openchargemap_lookup_reference.'),
    usageType: z.string().optional().describe('Access/usage type title (e.g. "Public", "Public - Pay At Location"). Absent when OCM has no usage type.'),
    isPayAtLocation: z.boolean().optional().describe('Whether payment is required at the location. Derived from UsageType.IsPayAtLocation. Absent when usage type is unknown.'),
    isMembershipRequired: z.boolean().optional().describe('Whether a membership or RFID card is required. Derived from UsageType.IsMembershipRequired. Absent when usage type is unknown.'),
    isAccessKeyRequired: z.boolean().optional().describe('Whether a physical access key is required. Derived from UsageType.IsAccessKeyRequired. Absent when usage type is unknown.'),
    numberOfPoints: z.number().optional().describe('Reported number of charge points (stalls). Often absent — absence means unknown, not zero.'),
    status: z.string().optional().describe('Registry operational status (e.g. "Operational", "Temporarily Unavailable"). Operator-reported; may be stale.'),
    isOperational: z.boolean().optional().describe('Whether the registry marks the status as operational. Absent (not null) when the StatusType is "Unknown" (ID=0) — the OCM API omits IsOperational from the StatusType object in that case. A true value can still mask a broken charger — corroborate with comments and dateLastVerified.'),
    dateLastVerified: z.string().nullable().optional().describe('ISO 8601 date the listing was last verified. Stale (e.g. >12 months) is a reliability caveat. null when never verified.'),
    isRecentlyVerified: z.boolean().optional().describe('OCM flag: whether the listing was verified recently.'),
    connections: z.array(z.object({
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
  })).describe('Matching stations, ordered by distance from the search point.'),
  totalCount: z.number().describe('Number of stations returned. Equals maxresults when the cap was hit — see truncated.'),
  searchSummary: z.string().describe('Human-readable echo of the resolved search: location mode, scope, and active filters as the server applied them.'),
  attribution: z.string().describe('Required attribution: "Station data © Open Charge Map contributors, licensed under CC BY 4.0 (openchargemap.org)."'),
})
```

`totalCount` via `ctx.enrich.total(n)`. Truncation via `ctx.enrich.truncated({ shown, cap })` — the standard `truncated` / `shown` / `cap` fields are populated by the framework **only when `maxresults` is hit**, so they are declared on the enrichment block, never as required `output` fields (declaring them required throws `-32007` on every non-truncated result). `searchSummary` and `attribution` carry agent-facing context that must reach both client surfaces — put them in `output` (so `format-parity` drags them into `format()`); the truncation block rides `enrichment`.

**`format()`** renders: a header line with `totalCount` + `searchSummary`, then per station a block — `**{title}** — {distance} {unit}` / address / operator + usageType / each connection as `{connectionType} · {powerKW} kW · {currentType} ×{quantity}` / a status line `Status: {status} · last verified {dateLastVerified}` with an explicit caveat when `dateLastVerified` is stale or `isOperational` is false/null — then the attribution. Every `output` field appears in the rendered text (lint-enforced).

**Errors:**

```ts
errors: [
  { reason: 'invalid_location', code: JsonRpcErrorCode.InvalidParams,
    when: 'Neither a center (latitude+longitude+distance) nor a boundingbox was provided, or both were',
    recovery: 'Provide either latitude + longitude (+ optional distance), or a boundingbox — exactly one. Geocode a place name with openstreetmap_geocode to obtain coordinates.' },
  { reason: 'no_stations', code: JsonRpcErrorCode.NotFound,
    when: 'The search and filters returned zero stations',
    recovery: 'Widen the distance/bounding box, relax filters (drop minpowerkw or connectiontypeid), or remove countrycode. Verify the coordinates are on land in a covered region.' },
  { reason: 'upstream_unavailable', code: JsonRpcErrorCode.ServiceUnavailable, retryable: true,
    when: 'OCM returned a non-2xx response or timed out',
    recovery: 'Retry after a short delay. If it persists, OCM may be rate-limiting or down — reduce call frequency.' },
  { reason: 'auth_failed', code: JsonRpcErrorCode.Unauthorized,
    when: 'OCM returned HTTP 403 — the API key is missing or invalid',
    recovery: 'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org). This is a server configuration issue, not an input error.' },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`.

---

### `openchargemap_get_station`

Full detail for one station. Wraps `GET /v3/poi?chargepointid=<id>` (numeric only). **UUID lookup is not supported** — passing a UUID string as `chargepointid` returns 100 random stations, not the matching station (verified). The `id` input accepts numeric IDs only. A non-existent numeric ID returns OCM HTTP 200 with `[]` — the handler detects the empty array and throws `not_found` (it must **not** return an empty/null station).

**Description (final):**
> Get the full record for one Open Charge Map station by its numeric OCM ID. Returns every connection (type, level, power, current, quantity, per-connection status), the operator and network, usage and access restrictions (pay-at-location, membership, access key), the number of charge points, general comments, usage cost, the data provider, media, and verification recency. Set includeComments to also return community check-ins inline. Obtain an ID from openchargemap_find_stations.

**Input:**

```ts
z.object({
  id: z.number().int().positive()
    .describe('Numeric OCM station ID (e.g. 145452). Obtain one from openchargemap_find_stations. Note: UUID lookup is not supported by the OCM API.'),
  includeComments: z.boolean().default(false)
    .describe('Include community check-ins and comments inline in the response. Adds payload but gives the real-world reliability signal alongside the registry status. For comments alone, use openchargemap_get_station_comments.'),
})
```

**Output:** A single `station` object — the `find_stations` station shape **plus** detail-only fields:

```ts
z.object({
  station: z.object({
    // ...all fields from the find_stations station shape, plus:
    generalComments: z.string().optional().describe('Operator/free-text notes about the station. Absent when none on record. Only returned by OCM when verbose=true is used — the detail call should use verbose=true.'),
    usageCost: z.string().optional().describe('Free-text cost description (e.g. "£0.30/kWh"). Often absent — absence means unknown, not free. Only returned by OCM when verbose=true is used.'),
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
      comment: z.string().optional().describe('Comment text.'),
      rating: z.number().nullable().optional().describe('User rating 1–5. null when not given.'),
      dateCreated: z.string().optional().describe('ISO 8601 timestamp the comment was posted.'),
    })).optional().describe('Community check-ins, present only when includeComments=true. Empty array means none on record.'),
  }).describe('The full station record.'),
  reliabilityNote: z.string().optional().describe('Server-computed caveat when registry status and recency suggest the listing may not reflect reality (e.g. "Listed operational but last verified 14 months ago; 2 of 3 recent comments report a fault."). Omitted when status is fresh and uncontested.'),
  attribution: z.string().describe('Required CC BY 4.0 attribution to Open Charge Map contributors.'),
})
```

> **`reliabilityNote` is honest signal, not a fabricated score.** It is plain prose derived from observable facts the server has — `dateLastVerified` age, `isOperational`, and the count of fault-type vs. positive comments when present. No synthetic confidence percentage or composite metric (per the no-fabricated-signal rule). Omitted entirely when there is nothing to caveat.

**Errors:**

```ts
errors: [
  { reason: 'not_found', code: JsonRpcErrorCode.NotFound,
    when: 'OCM returned an empty result for the given numeric ID (HTTP 200 with []) — no such station',
    recovery: 'Verify the numeric OCM ID. Find a valid station first with openchargemap_find_stations.' },
  { reason: 'upstream_unavailable', code: JsonRpcErrorCode.ServiceUnavailable, retryable: true,
    when: 'OCM returned a non-2xx response or timed out',
    recovery: 'Retry after a short delay.' },
  { reason: 'auth_failed', code: JsonRpcErrorCode.Unauthorized,
    when: 'OCM returned HTTP 403 — the API key is missing or invalid',
    recovery: 'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org).' },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`.

---

### `openchargemap_lookup_reference`

The DX layer. Resolves friendly names to the integer filter IDs `find_stations` needs, served from the bundled/cached reference snapshot — **no network round trip** (`openWorldHint: false`). Also browses a full category when `query` is omitted. This is the bounded-set, name→opaque-ID resolver pattern (MCP-side list filtering): strict token match over the full category, no fuzzy library for the default path.

**Description (final):**
> Resolve Open Charge Map reference data to the integer IDs that openchargemap_find_stations filters require. Pick a category and pass a name or code to resolve — "CCS" or "Tesla Supercharger" → a connectiontypeid, "ChargePoint" → an operatorid, "Public - Pay At Location" → a usagetypeid, "France" or "FR" → a country. Omit the query to browse the whole category. Served from a bundled snapshot — offline and instant. Use the returned id(s) in openchargemap_find_stations.

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
  ]).describe('Which reference set to query. connectiontypes → connectiontypeid; operators → operatorid; usagetypes → usagetypeid; statustypes → statustypeid; currenttypes → current type; levels → charge level (1/2/3); countries → ISO country.'),
  query: z.string().min(1).optional()
    .describe('Name, title, code, or alias to resolve (e.g. "CCS", "CHAdeMO", "Tesla", "Public", "France", "FR"). Case-insensitive, matches on title, formal name, and known aliases. Omit to browse the entire category.'),
  limit: z.number().int().min(1).max(100).default(25)
    .describe('Maximum entries to return when browsing or when a query matches several. Max 100.'),
})
```

**Output:**

```ts
z.object({
  category: z.string().describe('The reference category queried.'),
  matches: z.array(z.object({
    id: z.number().describe('The reference ID — pass to the matching openchargemap_find_stations filter (e.g. connectiontypeid).'),
    title: z.string().describe('Human-readable title (e.g. "CCS (Type 2)", "ChargePoint", "United States").'),
    formalName: z.string().nullable().optional().describe('Formal/standard name where applicable (e.g. "IEC 62196-3 Configuration FF" for CCS Type 2). null when none.'),
    isoCode: z.string().optional().describe('ISO 3166-1 alpha-2 code — countries category only.'),
    detail: z.string().optional().describe('Extra context where useful — e.g. for usagetypes whether pay-at-location / membership / access-key applies; for statustypes whether it counts as operational; for connectiontypes whether discontinued/obsolete.'),
  })).describe('Matching reference entries, best/exact match first. Use the id in a find_stations filter.'),
  totalCount: z.number().describe('Number of entries returned.'),
  filterParam: z.string().optional().describe('The find_stations input parameter these IDs feed (e.g. "connectiontypeid", "operatorid"). Omitted for categories with no direct filter (currenttypes, countries→use countrycode).'),
  snapshotDate: z.string().describe('Date the bundled reference snapshot was captured, so callers know the data vintage.'),
  attribution: z.string().describe('Required CC BY 4.0 attribution to Open Charge Map contributors.'),
})
```

`totalCount` via `ctx.enrich.total(n)`; truncation (browsing a category larger than `limit` — only `operators`/`countries` exceed it) via `ctx.enrich.truncated({ shown, cap })`, declared on the enrichment block. `format()` renders each match as `{id} — {title}{ formalName/isoCode/detail }`, then `filterParam` guidance, then `snapshotDate` + attribution.

**Matching:** normalize (lowercase, strip punctuation/diacritics) and require every query token to appear in title / formal name / alias, over the **complete** category set (not a page). Curated aliases for the connectors agents actually name: `J1772`→Type 1 (1), `CCS`→both CCS (32, 33) with CCS Type 2 (33) ranked first, `Supercharger`/`NACS`→27, `Type 2`→25/1036. No fuzzy fallback in v1 — on empty match, return zero matches with a recovery that says "browse the category with no query."

**Errors:**

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No reference entry in the category matched the query',
    recovery: 'Check spelling, try a shorter/more common term (e.g. "CCS" not "Combined Charging System"), or omit query to browse the whole category and pick the id.' },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` (no external call — bundled data).

---

### `openchargemap_get_station_comments`

Community check-ins for one station — the honest reliability signal beyond the registry flag. Wraps `GET /v3/poi?chargepointid=<id>&includecomments=true`, extracting the embedded `UserComments[]`. (There is **no** standalone `/v3/comments` GET endpoint — verified 404; comments are only available embedded in the POI.) Returns the comments **plus** the registry status and last-verified date so the agent can directly compare claim vs. reports.

**Note on `maxresults`:** This parameter controls how many comments the handler returns after extracting from the POI, but the OCM `/poi` endpoint itself does not paginate or limit the embedded `UserComments[]` array — all comments for the station are returned by the API and the handler trims to `maxresults` (newest first). There is no server-side comment pagination.

**Description (final):**
> Read community check-ins and comments for one Open Charge Map station — the real-world reliability signal beyond the operator-reported registry status. Returns user comments and fault reports with ratings and dates, alongside the station's current registry status and last-verified date so you can flag mismatches like "listed operational, but the last few check-ins report a fault." Obtain a station ID from openchargemap_find_stations.

**Input:**

```ts
z.object({
  id: z.number().int().positive()
    .describe('Numeric OCM station ID. Get one from openchargemap_find_stations. Note: UUID lookup is not supported by the OCM API.'),
  maxresults: z.number().int().min(1).max(100).default(25)
    .describe('Maximum comments to return (handler trims, newest first). The OCM API returns all embedded comments — this caps what the tool surfaces. Max 100.'),
})
```

**Output:**

```ts
z.object({
  stationId: z.number().describe('OCM station ID the comments belong to.'),
  stationTitle: z.string().describe('Station name, for context.'),
  registryStatus: z.string().optional().describe('Current registry operational status (operator-reported).'),
  isOperational: z.boolean().optional().describe('Whether the registry marks the station operational. Absent (not null) when status is Unknown — the OCM API omits IsOperational from the StatusType object for Unknown (ID=0). Compare against the comments below — they are the real-world check.'),
  dateLastVerified: z.string().nullable().optional().describe('ISO 8601 date the listing was last verified. null when never verified.'),
  comments: z.array(z.object({
    user: z.string().optional().describe('Commenter username. Absent for anonymous.'),
    commentType: z.string().optional().describe('Comment type (e.g. "General Comment", "Fault Report").'),
    comment: z.string().optional().describe('The comment text.'),
    rating: z.number().nullable().optional().describe('User rating 1–5. null when not given.'),
    dateCreated: z.string().optional().describe('ISO 8601 timestamp the comment was posted.'),
  })).describe('Community comments, newest first. Empty array means OCM has no check-ins for this station — absence of reports is not evidence the charger works.'),
  totalCount: z.number().describe('Number of comments returned.'),
  reliabilityNote: z.string().optional().describe('Server-computed caveat when status and comments disagree or the listing is stale (plain prose from observable facts; no synthetic score). Omitted when nothing to flag.'),
  attribution: z.string().describe('Required CC BY 4.0 attribution to Open Charge Map contributors.'),
})
```

`totalCount` via `ctx.enrich.total(n)`; truncation via `ctx.enrich.truncated({ shown, cap })` on the enrichment block. Empty `comments` is a valid, non-error result (the station exists but has no check-ins) — the description states that absence ≠ "works." `format()` renders the status/verified header, each comment as `[{dateCreated}] {user} ({commentType}, ★{rating}): {comment}`, the `reliabilityNote` when present, then attribution.

**Errors:**

```ts
errors: [
  { reason: 'not_found', code: JsonRpcErrorCode.NotFound,
    when: 'OCM returned an empty result for the given numeric ID (HTTP 200 with []) — no such station',
    recovery: 'Verify the numeric OCM ID. Find a valid station first with openchargemap_find_stations.' },
  { reason: 'upstream_unavailable', code: JsonRpcErrorCode.ServiceUnavailable, retryable: true,
    when: 'OCM returned a non-2xx response or timed out',
    recovery: 'Retry after a short delay.' },
  { reason: 'auth_failed', code: JsonRpcErrorCode.Unauthorized,
    when: 'OCM returned HTTP 403 — the API key is missing or invalid',
    recovery: 'Set a valid OPENCHARGEMAP_API_KEY (free signup at openchargemap.org).' },
]
```

> Note: empty comments is **not** an error — it returns `comments: []` with the station's status header. `not_found` fires only when the station itself doesn't exist.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`.

---

## Resources

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
| Stations (POI) — search | `GET /v3/poi?latitude=&longitude=&distance=&distanceunit=&boundingbox=&countrycode=&connectiontypeid=&minpowerkw=&operatorid=&usagetypeid=&levelid=&statustypeid=&minnumberofpoints=&maxresults=&compact=false&verbose=false&output=json` | `openchargemap_find_stations` |
| Stations (POI) — single | `GET /v3/poi?chargepointid=<id>&includecomments=<bool>&output=json` (numeric ID only; UUID lookup returns random results — not supported) | `openchargemap_get_station`, `openchargemap://station/{id}` |
| Comments / check-ins | **embedded in POI** via `&includecomments=true` → `UserComments[]` (no standalone `/v3/comments` GET — verified 404) | `openchargemap_get_station_comments`, `openchargemap_get_station` |
| Reference data | bundled snapshot of `GET /v3/referencedata` (`ConnectionTypes`, `Operators`, `UsageTypes`, `StatusTypes`, `CurrentTypes`, `ChargerTypes`, `Countries`) + optional startup refresh | `openchargemap_lookup_reference` (+ internal labeling) |

**OCM filter param names** (exact, for the service layer): `latitude`, `longitude`, `distance`, `distanceunit` (`KM`/`Miles`), `boundingbox` (`(lat,lng),(lat,lng)`), `countrycode`, `connectiontypeid` (comma-joined for arrays), `operatorid`, `usagetypeid`, `levelid`, `minpowerkw`, `statustypeid`, `minnumberofpoints`, `maxresults`, `chargepointid`, `includecomments`, `compact`, `verbose`, `output=json`. Array filters serialize as comma-separated values.

---

## Workflow Analysis

### Place name → nearest working CCS charger (the headline workflow)

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `openstreetmap_geocode` (openstreetmap server) | "Ballard, Seattle" → `{lat: 47.6685, lon: -122.387}` |
| 2 | `openchargemap_lookup_reference` | `category: "connectiontypes", query: "CCS"` → `connectiontypeid: 33` |
| 3 | `openchargemap_find_stations` | coordinates + `connectiontypeid: 33` + `minpowerkw: 50` → ranked nearby DC fast stations |
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

**Geocoding composes with `openstreetmap`, not rebuilt here.** OCM searches by lat/long + distance or bbox, never place names. The companion `openstreetmap` server already provides `openstreetmap_geocode`; `find_stations` documents the two-step explicitly and `invalid_location`'s recovery points at it. No geocoding code, no place-name input — keeps the surface coordinate-native and honest about the boundary.

**Reliability is surfaced as first-class output, not buried.** Registry `StatusType` can read "operational" while the charger is broken — the live probe confirmed a real station with status "Temporarily Unavailable" yet `IsOperational: true`, and "Unknown" (ID=0) carries **no** `IsOperational` field at all (the key is absent from the StatusType object, not null — verified). So: every station carries `status` + `isOperational` + `dateLastVerified`; `get_station` and `get_station_comments` compute a plain-prose `reliabilityNote` from observable facts (verification age, operational flag, fault-vs-positive comment counts); the `statustypeid` filter description warns the status is operator-reported and stale-prone. The note is honest signal — no synthetic confidence score (per the no-fabricated-signal rule), and it's omitted when there's nothing to flag.

**Comments come from the POI, not a comments endpoint.** `idea.md` assumed a `/v3/comments` feed; the live probe returned **404** for `GET /v3/comments`. Comments are only available embedded in the POI via `includecomments=true` (`UserComments[]`). `get_station_comments` is therefore backed by the same `/poi` call with `includecomments=true`, extracting and reshaping `UserComments`. This is the one material deviation from the idea sketch — the tool and its user goal are unchanged; only the backing endpoint differs.

**Empty results are modeled deliberately.** OCM returns HTTP 200 + `[]` for a non-existent `chargepointid` (verified for IDs in the normal range; very large IDs such as 9999999999 fall back to returning random stations — but those are not valid OCM IDs) — `get_station` / `get_station_comments` detect the empty array and throw `not_found` rather than returning a null record. For `find_stations`, zero matches is `no_stations` (NotFound) with a "widen/relax" recovery. For `get_station_comments`, an existing station with no check-ins returns `comments: []` (not an error) — and the description states absence of reports is not evidence the charger works (don't fabricate reliability from missing data).

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
- **Coordinate-native — no place-name search.** Place names must be geocoded externally (`openstreetmap_geocode`). The server intentionally does not geocode.
- **Connection-level power is frequently estimated or absent.** Many `PowerKW` values are OCM estimates ("kW power is an estimate based on the connection type" appears in connection comments) or null. `minpowerkw` filtering is only as good as the underlying data; treat power as approximate.
- **Reference snapshot vintage.** Bundled reference data is a point-in-time snapshot (dated via `snapshotDate` / `REFERENCE_SNAPSHOT_DATE`). New operators or connector types added to OCM after the snapshot won't resolve until the snapshot is refreshed or `OPENCHARGEMAP_REFERENCE_REFRESH` is enabled. Connector types are near-static; the operator list grows slowly.
- **`maxresults` caps the result set, not the corpus.** OCM may have more stations than returned; the truncation enrichment fields disclose when the cap was hit. There is no cursor-based pagination in v1 — widen filters or shrink the area instead.

---

## API Reference

| Aspect | Notes |
|:-------|:------|
| Base URL | `https://api.openchargemap.io/v3` (override: `OPENCHARGEMAP_BASE_URL`) |
| Auth | `X-API-Key: <key>` header on every request. Missing/invalid → **HTTP 403**. |
| Output | Always `output=json`. Use `compact=false&verbose=false` for search results (includes expanded `ConnectionType`/`Operator`/`StatusType` objects the formatters need). For single-station detail (`get_station`), use `compact=false&verbose=true` to also receive `GeneralComments`, `UsageCost`, `NumberOfPoints`, `MediaItems`, and extra `AddressInfo` fields (`AddressLine2`, `ContactEmail`) — these fields are absent or null in `verbose=false` responses. |
| POI search params | `latitude`,`longitude`,`distance`,`distanceunit`(`KM`/`Miles`),`boundingbox`(`(lat,lng),(lat,lng)`),`countrycode`,`connectiontypeid`,`operatorid`,`usagetypeid`,`levelid`,`minpowerkw`,`statustypeid`,`minnumberofpoints`,`maxresults` |
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

**POI (station)** — top-level: `ID`, `UUID`, `DataProviderID`, `OperatorID`, `UsageTypeID`, `StatusTypeID` (absent when no status set), `DateLastVerified` (nullable), `IsRecentlyVerified`, `NumberOfPoints` (often null), `UsageCost` (often null), `GeneralComments` (absent when none — key not always present), `DateLastStatusUpdate` (nullable), nested `OperatorInfo{ID,Title,WebsiteURL,…}`, `UsageType{ID,Title,IsPayAtLocation,IsMembershipRequired,IsAccessKeyRequired}` (null/absent when no usage type), `StatusType{ID,Title,IsOperational(absent for Unknown/ID=0),IsUserSelectable}` (**entire key absent** when OCM has no status — not always present), `SubmissionStatus{ID,Title}`, `DataProvider{ID,Title,WebsiteURL,License}`, `AddressInfo{ID,Title,AddressLine1,Town,StateOrProvince,Postcode,CountryID,Country{ISOCode,Title,ContinentCode},Latitude,Longitude,ContactTelephone1,AccessComments,RelatedURL,Distance(absent for bbox searches),DistanceUnit(int enum: 1=KM, 2=Miles)}`, `Connections[]`, `MediaItems[]` (null/absent when none), `UserComments[]` (only with `includecomments=true`). **`verbose=true` adds:** `GeneralComments`, `MediaItems`, `UserComments`, `NumberOfPoints`, `UsageCost`, `DateLastConfirmed`, `OperatorsReference`, `ParentChargePointID`, `PercentageSimilarity`, `MetadataValues`, plus extra AddressInfo fields (`AddressLine2`, `ContactEmail`, `ContactTelephone2`). The service should use `compact=false&verbose=false` for the base fields; upgrade to `verbose=true` only if `GeneralComments`/`UsageCost`/`NumberOfPoints` are needed in detail calls.

**Connection** — `ID`, `ConnectionTypeID`, `ConnectionType{ID,Title,FormalName(nullable)}`, `LevelID`, `Level{ID,Title,IsFastChargeCapable,Comments}`, `Amps`(nullable), `Voltage`(nullable), `PowerKW`(nullable), `CurrentTypeID`, `CurrentType{ID,Title,Description}`, `Quantity`(nullable), `Comments`(nullable).

**UserComment** — `ID`, `ChargePointID`, `CommentTypeID`, `CommentType{ID,Title}`, `UserName`(nullable), `Comment`, `Rating`(1–5, nullable), `DateCreated`.

**Reference entry (e.g. ConnectionType)** — `ID`, `Title`, `FormalName`(nullable), `IsDiscontinued`(nullable), `IsObsolete`(nullable). **Operator** — `ID`, `Title`, `WebsiteURL`(nullable), `Comments`, `PhonePrimaryContact`(nullable), `IsPrivateIndividual`, `ContactEmail`(nullable), `FaultReportEmail`(nullable). **Country** — `ID`, `Title`, `ISOCode`, `ContinentCode`.

---

## Attribution

Open Charge Map data is **CC BY 4.0** — attribution is mandatory (no share-alike, no anti-AI/anti-redistribution clause). Placement:

1. **Every tool output** carries an `attribution` string: `"Station data © Open Charge Map contributors, licensed under CC BY 4.0 (openchargemap.org)."`
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
| 2026-06-13 | Non-existent station (HTTP 200 + `[]`) → `not_found`; existing station with no comments → `comments: []` (not an error) | OCM signals "no such station" with an empty array, not a 404 — the handler must detect it. Distinguishing "doesn't exist" from "exists, no check-ins" matters: the latter must not be reported as missing, and absence of reports ≠ "works." |
| 2026-06-13 | Global by default; `countrycode` optional, no implicit country | Coverage is worldwide; a hardcoded country (esp. US) would silently break non-US queries. Return country + operator on each result so multi-region queries stay legible. |
| 2026-06-13 | All sparse/nullable upstream fields modeled `.optional()` with "absence = unknown" descriptions; truncation fields on the enrichment block only | OCM omits/nullifies fields heavily (verified: `NumberOfPoints`, `UsageCost`, comments, media, connection power/amps/voltage; `StatusType` key itself can be absent from some POI records). Required truncation fields would throw `-32007` on every non-truncated result; `ctx.enrich.truncated()` populates them only when the cap is hit. `totalCount` stays required via `ctx.enrich.total()`. |
| 2026-06-13 | `getPoi` (detail) uses `verbose=true`; `searchPois` uses `verbose=false` | Verified that `GeneralComments`, `UsageCost`, `NumberOfPoints`, `MediaItems`, and extra AddressInfo fields (`AddressLine2`, `ContactEmail`, `ContactTelephone2`) are only present in `verbose=true` responses. `verbose=false` leaves those fields absent/null. The search method stays `verbose=false` for payload efficiency; the detail method uses `verbose=true` to surface the full record. |
| 2026-06-13 | UUID input removed from `get_station` and `get_station_comments`; `id` is numeric only | Verified that passing a UUID string as `chargepointid` returns 100 random stations (a default listing), not the matching station. No UUID-to-numeric lookup param exists. All tools accept numeric OCM IDs only; the UUID field is exposed in output for reference but cannot be used as lookup input. |
| 2026-06-13 | Coordinate-native; geocoding via `openstreetmap_geocode`, not rebuilt | OCM is coordinate-only. The companion `openstreetmap` server already provides geocoding; documenting the two-step keeps the boundary honest and the surface small. |
| 2026-06-13 | `lookup_reference` resolves via strict token match over the full bounded set + curated connector aliases; no fuzzy fallback in v1 | The bounded-set name→opaque-ID pattern (MCP-side list filtering). Strict normalized token match is the ~90% case; aliases (`J1772`, `CCS`, `Supercharger`/`NACS`, `Type 2`) cover the connectors agents actually name. On empty match, recovery says "browse the category" rather than guessing — lets the model self-correct. |
| 2026-06-13 | No DataCanvas, no write tools, one resource (`openchargemap://station/{id}`) | Discovery/record surface, not analytical rows (shape-not-size). Writes need moderation, defer. The single resource is the detail tool's convenience twin; no reference resource (it's a resolve surface, not a stable-by-URI record). |
| 2026-06-13 | CC BY 4.0 attribution in every tool output + README + server `instructions` | Mandatory license term. Same class as other attribution-required open-data sources (`openstreetmap`, `openfoodfacts`); credit "Open Charge Map" + contributors, no anti-AI clause to work around. |
| 2026-06-13 | Display identity = hyphenated machine name `openchargemap-mcp-server` everywhere | Fleet rule — `createApp` `title`, manifest `display_name`, docs headers all use the machine name; Title Case is a known agent failure mode. `description` derives from package.json (not duplicated into the identity block). |

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
| 12 | **`verbose=true` required for detail calls** — `generalComments`, `usageCost`, `numberOfPoints`, `mediaItems` absent in `verbose=false` | Verified: `verbose=true` response includes these fields; `verbose=false` omits or nulls them. Updated Services section (`getPoi` uses `verbose=true`), `get_station` output descriptions, and API Reference Output row. Decisions Log entry added. |
| 13 | **`get_station_comments` `maxresults` behavior clarified** | The OCM API returns all embedded `UserComments[]` via `includecomments=true` — there is no server-side comment pagination. The handler trims to `maxresults` client-side. Added a "Note on `maxresults`" block to the tool detail section. |
| 14 | **Large-int ID fallback behavior noted** | Verified: very large IDs (e.g., 9999999999) cause the OCM API to return a 100-item default listing rather than `[]`. IDs in the normal numeric range (up to ~9 digits) correctly return `[]` for non-existent stations. Not-found detection by empty array is correct for realistic usage. Noted in Design Decisions empty-results entry. |

### Non-changes (confirmed correct)

- `/v3/comments` endpoint returns 404 — the design's decision to use `includecomments=true` on the POI is correct.
- `X-API-Key` header required; both missing and invalid keys return HTTP 403 (not 401). `auth_failed` error code and Unauthorized mapping are correct.
- Bounding box format `(sw_lat,sw_lng),(ne_lat,ne_lng)` works. Distance field absent for bbox results (confirmed).
- `minnumberofpoints` is the correct OCM param name (not `minchargepoints`). The Zod input param is `minchargepoints` (user-facing name) that maps to OCM `minnumberofpoints` in the service layer — design is correct.
- Truncation via `ctx.enrich.truncated()` on enrichment block (not required output fields) — correct per the recurring `-32007` bug pattern.
- `totalCount` via `ctx.enrich.total()` — correct.
- Identity: `createApp` `name`=`title`=`openchargemap-mcp-server`; `description` from package.json only (not duplicated into identity block) — correct.
- Reference data counts from live API: ConnectionTypes=43, Operators=974, Countries=250, StatusTypes=10, UsageTypes=8, ChargerTypes=3, CurrentTypes=3 — match the design's service layer description.
- Verified reference IDs (connector types, current types, levels, usage types) in API Reference table are accurate.
