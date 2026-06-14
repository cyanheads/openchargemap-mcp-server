/**
 * @fileoverview Server-specific configuration for openchargemap-mcp-server.
 * Lazy-parsed Zod schema, separate from the framework's core config. Maps schema
 * paths to env var names via `parseEnvConfig` so a missing/invalid value names the
 * variable (e.g. `OPENCHARGEMAP_API_KEY`) rather than the schema path.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Default Open Charge Map API base URL. */
export const DEFAULT_OCM_BASE_URL = 'https://api.openchargemap.io/v3';

const ServerConfigSchema = z.object({
  /** OCM API key, sent as the `X-API-Key` header on every request. Required. */
  apiKey: z
    .string()
    .min(1)
    .describe(
      'Open Charge Map API key, sent as the X-API-Key header. Free instant signup at openchargemap.org.',
    ),
  /** OCM API base URL. Override for a private mirror or testing. */
  baseUrl: z.string().url().default(DEFAULT_OCM_BASE_URL).describe('Open Charge Map API base URL.'),
  /** When true, refresh reference data from /v3/referencedata at startup (bundled snapshot fallback). */
  referenceRefresh: z
    .stringbool()
    .default(false)
    .describe(
      'Refresh reference data from the live OCM endpoint at startup, falling back to the bundled snapshot on failure.',
    ),
});

/** Parsed server config shape. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config from the environment.
 * Throws `ConfigurationError` (rendered as a clean startup banner) when required vars are missing.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'OPENCHARGEMAP_API_KEY',
    baseUrl: 'OPENCHARGEMAP_BASE_URL',
    referenceRefresh: 'OPENCHARGEMAP_REFERENCE_REFRESH',
  });
  return _config;
}

/** Reset the cached config (test isolation only). */
export function resetServerConfig(): void {
  _config = undefined;
}
