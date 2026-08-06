<div align="center">
  <h1>@cyanheads/openchargemap-mcp-server</h1>
  <p><b>Find EV charging stations worldwide by location and connector via the global Open Charge Map registry — full station detail, reference-ID resolution, and community reliability check-ins via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openchargemap-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openchargemap-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openchargemap-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openchargemap-mcp-server/releases/latest/download/openchargemap-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openchargemap-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmNoYXJnZW1hcC1tY3Atc2VydmVyIl0sImVudiI6eyJPUEVOQ0hBUkdFTUFQX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openchargemap-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenchargemap-mcp-server%22%5D%2C%22env%22%3A%7B%22OPENCHARGEMAP_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openchargemap.caseyjhand.com/mcp](https://openchargemap.caseyjhand.com/mcp)

</div>

---

## Tools

Four tools across the find-and-detail surface — search, detail, offline ID resolution, and the community reliability layer:

| Tool | Description |
|:---|:---|
| `openchargemap_find_stations` | Find charging stations near a point or within a bounding box, filtered by connector, power, network, usage, status, and charge points. Coordinate-native. |
| `openchargemap_get_station` | Full record for one station by numeric OCM ID — every connection, operator, access rules, charge points, cost, media, and a computed reliability note. |
| `openchargemap_lookup_reference` | Resolve connector/operator/usage/status/country names to the integer filter IDs `find_stations` needs. Served from a bundled snapshot — offline and instant. |
| `openchargemap_get_station_comments` | Community check-ins for one station alongside the registry status and last-verified date, so registry-vs-reality mismatch is visible. |

### `openchargemap_find_stations`

The workhorse. Search the global registry by location, then narrow with filters.

- Radius search (`latitude` + `longitude` + `distance`, in `KM` or `Miles`) or `boundingbox` — exactly one mode per call
- Optional country scope via ISO 3166-1 alpha-2 `countrycode`; global by default, no implicit country
- Filters: connector type, minimum power (kW), operator/network, usage type, charge level, operational status, minimum charge points — all integer IDs, single or OR-matched arrays
- Resolve a connector or network name to its filter ID with `openchargemap_lookup_reference` first (e.g. `"CCS"` → `33`)
- Each result carries title, address, distance, connections (type/power/current/count), operator, access rules, registry status, and `dateLastVerified`
- `maxresults` caps the set (default 25, max 200), ordered by distance; truncation is disclosed when the cap is hit
- **Coordinate-native — does not geocode place names.** Resolve a place like "Ballard, Seattle" to coordinates with a geocoding server (e.g. the `openstreetmap` MCP server's `openstreetmap_geocode`) first, then pass them here

---

### `openchargemap_get_station`

Full detail for one station by its numeric OCM ID (fetched with `verbose=true`).

- Every connection: type, level, power, current, amperage, voltage, quantity
- Operator and network, usage and access restrictions (pay-at-location, membership, access key), number of charge points
- General comments, usage cost, data provider, submitted media, verification recency
- Optional inline community check-ins with `includeComments`
- Computes a plain-prose `reliabilityNote` from observable facts (verification age, registry status, operational flag, fault-vs-positive check-in counts) — no synthetic score; omitted when status is fresh and uncontested
- A status of "Temporarily Unavailable" or "Partly Operational (Mixed)" raises a caveat of its own — OCM flags both operational, so the flag alone would read as all-clear on a station the operator has said is down
- Obtain an ID from `openchargemap_find_stations`. UUID lookup is not supported by the OCM API.

---

### `openchargemap_lookup_reference`

Resolve Open Charge Map reference data to the integer IDs the `find_stations` filters require — served from a bundled snapshot, so it makes **no network call** (offline, instant).

- Categories: `connectiontypes`, `operators`, `usagetypes`, `statustypes`, `currenttypes`, `levels`, `countries`
- Pass a `query` to resolve a name, title, code, or alias (`"CCS"`, `"Tesla Supercharger"`, `"ChargePoint"`, `"Public - Pay At Location"`, `"France"`, `"FR"`) — case-insensitive, matched on title, formal name, and curated connector aliases
- Omit the `query` to browse the whole category (up to `limit`, max 100)
- Returns the matching `id`(s) plus the `filterParam` they feed and the snapshot vintage (`snapshotDate`)
- An optional startup refresh keeps the snapshot from drifting — see `OPENCHARGEMAP_REFERENCE_REFRESH` below

---

### `openchargemap_get_station_comments`

Community check-ins for one station — the honest reliability signal beyond the operator-reported registry flag.

- Returns user comments and fault reports with ratings, dates, and the recorded check-in outcome ("Charged Successfully", "Failed to Charge (Equipment Not Operational)", …), newest first (`maxresults` caps, max 100)
- The check-in outcome is the charge-attempt result and drives fault detection — a failed charge counts even when it was filed as a plain comment
- Surfaces the station's registry status, operational flag, and `dateLastVerified` alongside the comments so you can flag mismatches like "listed operational, but recent check-ins report a fault"
- An empty result is **not** an error — a station with no check-ins returns `comments: []`; absence of reports is not evidence the charger works
- Backed by the POI fetch with `includecomments=true` (OCM has no standalone comments endpoint)
- Obtain a station ID from `openchargemap_find_stations`

## Resource

| Type | Name | Description |
|:---|:---|:---|
| Resource | `openchargemap://station/{id}` | Full station record (with community comments) by numeric OCM ID — the URI-addressable twin of `openchargemap_get_station`. |

All station data is also reachable via the tools. The station corpus (~200k locations, geo-scoped) is not exposed as a listable resource — discover stations with `openchargemap_find_stations`. Reference data is a resolve surface, not a stable-by-URI record, so it is served by `openchargemap_lookup_reference` rather than a resource.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats; typed error contracts with recovery hints
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Open Charge Map–specific:

- Type-safe client for the OCM v3 POI API with retry and session-scoped result caching
- Reference data (connectors, operators, usage/status types, countries) bundled as an offline snapshot — name→ID resolution needs no live `/referencedata` call, with an optional startup refresh to prevent drift
- Curated connector aliases (`CCS`, `NACS`/`Supercharger`, `J1772`, `Type 2`, `CHAdeMO`) so the names agents actually use resolve to the right IDs
- Geocoding intentionally delegated — the server is coordinate-native and composes with any geocoding MCP server rather than rebuilding place-name lookup

Agent-friendly output:

- Reliability surfaced as first-class signal — `status`, `statusTypeId`, `isOperational`, and `dateLastVerified` on every station, plus a plain-prose `reliabilityNote` derived only from observable facts (no fabricated confidence score). Upstream values are passed through verbatim; where a status contradicts its own operational flag, the judgment lives in the note and the rendered text, never in the boolean
- Honest sparsity — heavily-omitted upstream fields are optional with "absence means unknown, not zero/false" descriptions; the server never invents data OCM didn't return. An explicit `false` is a fact and reaches the text output, not just `structuredContent`
- CC BY 4.0 attribution on every tool response and in the server-level instructions, per the data license

## Getting started

### Public Hosted Instance

A public instance is available at `https://openchargemap.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP, with this client config:

```json
{
  "mcpServers": {
    "openchargemap-mcp-server": {
      "type": "streamable-http",
      "url": "https://openchargemap.caseyjhand.com/mcp"
    }
  }
}
```

### Local / self-hosted

Add the following to your MCP client configuration file. An Open Charge Map API key is required — see [Prerequisites](#prerequisites).

```json
{
  "mcpServers": {
    "openchargemap-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openchargemap-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OPENCHARGEMAP_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openchargemap-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openchargemap-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OPENCHARGEMAP_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "openchargemap-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "OPENCHARGEMAP_API_KEY=your-api-key",
        "ghcr.io/cyanheads/openchargemap-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 OPENCHARGEMAP_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3](https://bun.sh/) or higher (or Node.js v24+).
- An Open Charge Map API key — free instant signup: register an application at [openchargemap.org](https://openchargemap.org/site/profile/applications). Sent as the `X-API-Key` header on every request; the server fails fast at startup if it's unset.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openchargemap-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openchargemap-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set OPENCHARGEMAP_API_KEY
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `OPENCHARGEMAP_API_KEY` | **Required.** Open Charge Map API key, sent as the `X-API-Key` header. Free signup at [openchargemap.org](https://openchargemap.org/site/profile/applications). | — |
| `OPENCHARGEMAP_BASE_URL` | OCM API base URL. Override for a private mirror or testing. | `https://api.openchargemap.io/v3` |
| `OPENCHARGEMAP_REFERENCE_REFRESH` | When `true`, refresh reference data from the live `/referencedata` endpoint at startup, falling back to the bundled snapshot on failure. When `false`, stay fully offline on the bundled snapshot. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t openchargemap-mcp-server .
docker run --rm -e OPENCHARGEMAP_API_KEY=your-key -p 3010:3010 openchargemap-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/openchargemap-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/data` | Bundled Open Charge Map reference snapshot (`ocm-reference-data.ts`) — the offline source for ID resolution. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) plus the shared station schema and renderers. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/openchargemap` | OCM POI API client, response normalization, attribution, and the reliability-note helper. |
| `src/services/reference-data` | Reference-data service — snapshot loading, lookup indices, curated aliases, optional live refresh. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`AGENTS.md`](./AGENTS.md) (and [`CLAUDE.md`](./CLAUDE.md)) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Attribution and data license

Charging-station, connector, and operator data is sourced from **[Open Charge Map](https://openchargemap.org)**, the community-maintained global registry of EV charging locations, and is licensed under [**CC BY 4.0**](https://creativecommons.org/licenses/by/4.0/).

> Station data © Open Charge Map contributors, licensed under CC BY 4.0 (openchargemap.org).

Attribution is mandatory: every tool response carries this `attribution` string, and the server restates it in its session-level `instructions`. Any downstream use of the data must credit Open Charge Map and its contributors. This server's own code is Apache-2.0 (below); the license terms above apply to the **data**, not the software.

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details. Open Charge Map data carries its own license; see [Attribution and data license](#attribution-and-data-license).
