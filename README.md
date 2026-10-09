<div align="center">
  <h1>@cyanheads/openchargemap-mcp-server</h1>
  <p><b>Find EV charging stations worldwide by location and connector from the global Open Charge Map registry — full station detail, reference-ID resolution, and community reliability check-ins via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.9-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openchargemap-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openchargemap-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openchargemap-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openchargemap-mcp-server/releases/latest/download/openchargemap-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openchargemap-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmNoYXJnZW1hcC1tY3Atc2VydmVyIl0sImVudiI6eyJPUEVOQ0hBUkdFTUFQX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openchargemap-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenchargemap-mcp-server%22%5D%2C%22env%22%3A%7B%22OPENCHARGEMAP_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openchargemap.caseyjhand.com/mcp](https://openchargemap.caseyjhand.com/mcp)

</div>

---

## Overview

EV charging stations from the global Open Charge Map registry. Search by location and connector, pull full station detail, resolve connector and network names to filter IDs, and read community reliability check-ins from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openchargemap_find_stations` | Find charging stations near a point or within a bounding box, filtered by connector, power, network, usage, status, and charge points. Coordinate-native. |
| `openchargemap_get_station` | Full record for one station by numeric OCM ID — every connection, operator, access rules, charge points, cost, media, and a computed reliability note. |
| `openchargemap_lookup_reference` | Resolve connector/operator/usage/status/country names to the integer filter IDs `find_stations` needs. Served from a bundled snapshot — offline and instant. |
| `openchargemap_get_station_comments` | Community check-ins for one station alongside the registry status and last-verified date, so registry-vs-reality mismatch is visible. |

### Resources

| Resource | Description |
|:---|:---|
| `openchargemap://station/{id}` | Full station record (with community comments) by numeric OCM ID — the URI-addressable twin of `openchargemap_get_station`. |

All station data is also reachable via the tools; the station corpus (~200k locations, geo-scoped) isn't exposed as a listable resource, and reference data is served by `openchargemap_lookup_reference` rather than a resource.

## Capability reference

### `openchargemap_find_stations` <sub>tool</sub>

- Radius search (`latitude` + `longitude` + `distance`, `distanceUnit` `KM` or `Miles`, max 500) or `boundingbox` — exactly one mode per call; optional `countrycode` (ISO 3166-1 alpha-2) and filters `connectiontypeid`, `minpowerkw`, `operatorid`, `usagetypeid`, `levelid`, `statustypeid`, `minchargepoints` (the ID filters take one integer ID or an OR-matched array, resolved via `openchargemap_lookup_reference`)
- `maxresults` caps the page (default 25, max 200) and `offset` pages through up to 500 stations per search; `totalCount` is exact only when OCM's candidate page came back short of its cap — otherwise it's a floor, and the `notice` says which
- Fails with `invalid_location` (no search area, half a center, or a coordinate beside a `boundingbox`), `no_stations`, `auth_failed`, or `upstream_unavailable`

---

### `openchargemap_get_station` <sub>tool</sub>

- Full record for one station by numeric OCM `id` — every connection, operator/network, usage and access rules, charge-point count, usage cost, data provider, media, and `dateLastVerified`; `includeComments` adds every check-in inline, unpaged (use `openchargemap_get_station_comments` for a heavily-commented station)
- `reliabilityNote` is plain prose computed from observable facts (verification age, registry status, operational flag, fault-vs-positive check-ins), omitted when there is nothing to flag; fails with `not_found`, `auth_failed`, or `upstream_unavailable`

---

### `openchargemap_lookup_reference` <sub>tool</sub>

- `category` (`connectiontypes`, `operators`, `usagetypes`, `statustypes`, `currenttypes`, `levels`, `countries`) plus an optional case-insensitive `query` naming a title, code, or alias (`"CCS"`, `"Tesla Supercharger"`, `"FR"`); omit `query` to browse the category (`limit` max 100, default 25, paged via `offset`/`nextOffset`)
- Returns the matching `id`(s), the `filterParam` they feed into `openchargemap_find_stations`, and `source` (`live` or `bundled`) with a `snapshotDate` — answered offline from the bundled snapshot unless `OPENCHARGEMAP_REFERENCE_REFRESH` refreshed it at startup; fails with `no_match`

---

### `openchargemap_get_station_comments` <sub>tool</sub>

- Check-ins for one station by numeric OCM `id`, newest first, each with rating, date, and recorded outcome — `maxresults` caps the page (default 25, max 100), paged via `offset`/`nextOffset`; `totalComments` counts the station's whole set, and `reliabilityNote`'s fault ratio is computed over all of it
- Returns the registry status, `isOperational`, and `dateLastVerified` beside the comments; an empty `comments: []` is not an error (no reports is not evidence the charger works); fails with `not_found`, `auth_failed`, or `upstream_unavailable`

---

### `openchargemap://station/{id}` <sub>resource</sub>

- Full record for one station by numeric OCM ID, community comments always included — the URI-addressable twin of `openchargemap_get_station`, cached for 600 seconds, and not listable
- Fails with `not_found` when the ID doesn't resolve to a station

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Open Charge Map-specific:

- Type-safe client for the OCM v3 POI API with retry and session-scoped result caching
- Reference data (connectors, operators, usage/status types, countries) bundled as an offline snapshot — name→ID resolution needs no live `/referencedata` call, with an optional startup refresh to prevent drift
- Curated connector aliases (`CCS`, `NACS`/`Supercharger`, `J1772`, `Type 2`, `CHAdeMO`) so the names agents actually use resolve to the right IDs
- Geocoding intentionally delegated — the server is coordinate-native and composes with any geocoding MCP server (e.g. the `openstreetmap` server's `openstreetmap_search_places`) rather than rebuilding place-name lookup
- Stations are addressed by numeric OCM ID, discovered through `openchargemap_find_stations` — the OCM API has no UUID lookup

Agent-friendly output:

- Reliability surfaced as first-class signal — `status`, `statusTypeId`, `isOperational`, and `dateLastVerified` on every station, plus a plain-prose `reliabilityNote` derived only from observable facts (no fabricated confidence score)
- Honest sparsity — heavily-omitted upstream fields are optional with "absence means unknown, not zero/false" descriptions; the server never invents data OCM didn't return
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

### Self-Hosted / Local

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

- [Bun v1.4](https://bun.sh/) or higher (or Node.js v24+).
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
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details. Open Charge Map data carries its own license; see [Attribution and data license](#attribution-and-data-license).
