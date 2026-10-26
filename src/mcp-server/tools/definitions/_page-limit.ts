/**
 * @fileoverview Shared page-size validation and clamp telemetry for the three paginated tools.
 * @module mcp-server/tools/definitions/_page-limit
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { clampLimitsEnabled } from '@/config/server-config.js';

const clamps = createCounter(
  'openchargemap.pagination.clamps',
  'Oversized page sizes clamped',
  '{clamps}',
);

/** Keep the advertised schema open above the cap; the compatibility switch restores rejection. */
export const pageLimitSchema = (cap: number) =>
  z
    .number()
    .int()
    .min(1)
    .refine((value) => clampLimitsEnabled() || value <= cap, {
      message: `Must be at most ${cap} when OPENCHARGEMAP_CLAMP_LIMITS=false.`,
    });

/** Apply a validated page size once and return a notice that composes with result guidance. */
export function applyPageLimit(
  requested: number,
  cap: number,
  tool: 'find_stations' | 'get_station_comments' | 'lookup_reference',
  parameter: 'maxresults' | 'limit',
  ctx: Context,
): { value: number; notice?: string } {
  if (requested <= cap) return { value: requested };
  ctx.log.notice('OCM page size clamped', { tool, parameter, requested, applied: cap });
  clamps.add(1, { tool, parameter });
  return {
    value: cap,
    notice: `Requested ${parameter}=${requested}; applied ${cap} (maximum page size).`,
  };
}
