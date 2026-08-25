# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-08-25 · ⚠️ Breaking

Tool inputs are now strict at the root, the station resource declares an output schema and cache lifetime, and the Docker build cross-compiles cleanly on Bun 1.4

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-08-06

Offset pagination on capped list outputs, fixed find_stations cap accounting, and reference-data source disclosure

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-08-06

Error-path accuracy fixes, stricter input validation, and malformed-response handling

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-08-06

Registry-status honesty and check-in outcomes in the station renderers; mcp-ts-core ^0.11.1; broadened test coverage

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-07-04 · 🛡️ Security

Local minchargepoints enforcement and zero-coordinate filtering in find_stations; tightened tool/resource descriptions; dependency bump clears a moderate js-yaml DoS advisory

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-20

mcp-ts-core ^0.10.6 → ^0.10.9 maintenance — fresh-scaffold devcheck guards, new check-dependency-specifiers step, plugin-manifest packaging checks, synced framework skills

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-15

Add public hosted endpoint at openchargemap.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Action-first package, manifest, and plugin descriptions — lead with what the server does.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release — global Open Charge Map EV charging: find stations, get detail, resolve reference IDs, and read community reliability check-ins.
