---
name: openchargemap-guide
description: Assess EV charging options with openchargemap_* tools. Use when recommending a compatible, accessible charger, checking conflicting reliability evidence, or deciding whether a station search covers the requested area.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Open Charge Map to discover registered charging stations and inspect their equipment, access conditions and community check-ins. It cannot guarantee present operation or an unoccupied stall, plan a driving route, or search a global stream of fault reports. Live station calls require the server's configured Open Charge Map API key.

Place-name resolution composes with an external geocoder such as `openstreetmap_search_places`; an existing coordinate or bounding box needs no geocoding step.

## Identifiers

- `openchargemap_find_stations` returns the numeric station `id` used by `openchargemap_get_station` and `openchargemap_get_station_comments`. A station's `uuid` cannot be used to fetch it.
- `openchargemap_lookup_reference` returns category-specific reference IDs. Follow its `filterParam` when present; country entries instead supply `isoCode`. A numeric country ID is not a country search code, and current-type entries have no direct search filter.
- Connector families can resolve to multiple entries. Select the variants appropriate to the user's equipment and region rather than treating the first match as universal. An unknown connector entry does not establish vehicle compatibility.

## Gates

1. **Confirm the applied search scope before comparing results.** Read the search summary and notices. An unrecognized country code is not applied, so resolve a valid country code and repeat before describing results as country-restricted.
2. **Check the intended connection before recommending a station.** A station can have several connector types and power ratings. Inspect the matching connection's power, status and notes with `openchargemap_get_station`, together with station access restrictions and cost. A search match does not establish that the user's connector supplies the station's highest power. Missing power, quantity or access evidence stays unknown; estimated power is not guaranteed delivery.
3. **Separate recent evidence from registry claims.** Compare status text, operational flags, verification dates and dated check-in outcomes before calling a charger usable. A station-level operational flag does not override an unavailable or partly operational status, or a fault on the intended connection. No comments and no reliability warning are not confirmations that charging works.
4. **Establish coverage before claiming absence or completeness.** An empty successful response may mean no matches, an offset past the end, or no matching stations in the retrieved candidate pool. Use the notice and counts to distinguish them. Follow `nextOffset` when supplied; if the notice says upstream stations remain beyond the pool, narrow the area or add suitable filters. A retrieved count is then a floor, not the area's total. Even an exhausted registry search establishes only what OCM records for that scope.
5. **Resolve reference misses before relaxing the user's requirements.** For an empty lookup, check spelling, broaden the term or browse the category. Read `source` with `snapshotDate`: a bundled snapshot may lack a recently added operator or connector. Do not silently remove an unresolved filter or conclude the network does not exist.

## Workflows

### Recommend a nearby charger

Establish the user's location, connector and access requirements. Resolve the needed reference entries, then use `openchargemap_find_stations` for candidates. Inspect the most relevant candidates with `openchargemap_get_station` and compare the intended connections, access notes and cost before choosing.

Use `openchargemap_get_station_comments` for dated reliability evidence on the shortlist. Explain material conflicts or missing evidence alongside the recommendation. If the nearest candidate is unsuitable, evaluate another returned candidate or continue the search; proximity alone does not settle suitability.

### Assess a known station

Use the numeric station ID to get its detail, then read comments when the question concerns reliability. Comments are newest first, but the returned `reliabilityNote` evaluates the station's whole comment history, not just the displayed page. Distinguish a recent pattern from that historical summary; read further pages when the conclusion requires older evidence. An empty page with comments still on record calls for a lower offset, not a claim that nobody has reported a problem.

### Compare or enumerate an area

Keep the search scope and filters fixed while following continuation offsets. Read the reported page cap and notices rather than assuming a requested page size was applied: oversized requests may be clamped. Records can shift between calls as OCM changes; deduplicate by numeric station ID when combining pages. If the candidate pool leaves upstream records unread, narrow the area and preserve the coverage limitation in any count or comparison.

Preserve returned attribution when presenting or exporting records. Station provider license terms vary; inspect the provider information before treating records as uniformly licensed.
