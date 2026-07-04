/**
 * @fileoverview openchargemap_lookup_reference — resolve Open Charge Map reference names/codes to
 * the integer filter IDs openchargemap_find_stations requires, served from a bundled snapshot
 * (offline, instant). Browse a full category when no query is given.
 * @module mcp-server/tools/definitions/lookup-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION } from '@/services/openchargemap/attribution.js';
import { getReferenceDataService } from '@/services/reference-data/reference-data-service.js';
import type { ReferenceCategory } from '@/services/reference-data/types.js';

export const lookupReference = tool('openchargemap_lookup_reference', {
  title: 'openchargemap-mcp-server: lookup reference',
  description:
    'Resolve Open Charge Map reference data to the integer IDs that openchargemap_find_stations filters require. Pick a category and pass a name or code to resolve — "CCS" or "Tesla Supercharger" -> a connectiontypeid, "ChargePoint" -> an operatorid, "Public - Pay At Location" -> a usagetypeid, "France" or "FR" -> a country. Omit the query to browse the whole category.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    category: z
      .enum([
        'connectiontypes',
        'operators',
        'usagetypes',
        'statustypes',
        'currenttypes',
        'levels',
        'countries',
      ])
      .describe(
        'Which reference set to query. connectiontypes -> connectiontypeid; operators -> operatorid; usagetypes -> usagetypeid; statustypes -> statustypeid; currenttypes -> current type; levels -> charge level (1/2/3); countries -> ISO country.',
      ),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Name, title, code, or alias to resolve (e.g. "CCS", "CHAdeMO", "Tesla", "Public", "France", "FR"). Case-insensitive, matches on title, formal name, and known aliases. Omit to browse the entire category.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Maximum entries to return when browsing or when a query matches several. Max 100.',
      ),
  }),

  output: z.object({
    category: z.string().describe('The reference category queried.'),
    matches: z
      .array(
        z
          .object({
            id: z.number().describe('The reference ID for this entry.'),
            title: z
              .string()
              .describe(
                'Human-readable title (e.g. "CCS (Type 2)", "ChargePoint", "United States").',
              ),
            formalName: z
              .string()
              .nullable()
              .optional()
              .describe('Formal/standard name where applicable. null when none.'),
            isoCode: z
              .string()
              .optional()
              .describe('ISO 3166-1 alpha-2 code — countries category only.'),
            detail: z
              .string()
              .optional()
              .describe(
                'Extra interpretive context (operational flag, pay/membership/access, discontinued/obsolete, continent).',
              ),
          })
          .describe('A matching reference entry.'),
      )
      .describe('Matching reference entries, best/exact match first.'),
    filterParam: z
      .string()
      .optional()
      .describe(
        'The find_stations input parameter these IDs feed (e.g. "connectiontypeid"). Omitted for categories with no direct filter (currenttypes; countries use countrycode).',
      ),
    snapshotDate: z
      .string()
      .describe(
        'Date the bundled reference snapshot was captured, so callers know the data vintage.',
      ),
    attribution: z
      .string()
      .describe('Required CC BY 4.0 attribution to Open Charge Map contributors.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Number of entries returned.'),
    truncated: z.boolean().optional().describe('True when a browse was capped at limit.'),
    shown: z.number().optional().describe('Number of entries returned when the cap was hit.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Guidance when a query matched nothing.'),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No reference entry in the category matched the query.',
      recovery:
        'Check spelling, try a shorter/more common term (e.g. "CCS" not "Combined Charging System"), or omit query to browse the whole category and pick the id.',
    },
  ],

  handler(input, ctx) {
    const ref = getReferenceDataService();
    const category = input.category as ReferenceCategory;
    const filterParam = ref.filterParam(category);

    if (input.query !== undefined && input.query.trim().length > 0) {
      const matches = ref.resolve(category, input.query, input.limit);
      if (matches.length === 0) {
        ctx.enrich.notice(
          `No ${category} entry matched "${input.query}". Omit the query to browse the whole category and pick an id.`,
        );
        throw ctx.fail('no_match', `No ${category} entry matched "${input.query}".`, {
          ...ctx.recoveryFor('no_match'),
        });
      }
      ctx.enrich.total(matches.length);
      return {
        category,
        matches,
        ...(filterParam ? { filterParam } : {}),
        snapshotDate: ref.snapshotDate,
        attribution: ATTRIBUTION,
      };
    }

    // Browse mode.
    const { matches, total } = ref.browse(category, input.limit);
    ctx.enrich.total(total);
    if (total > input.limit) {
      ctx.enrich.truncated({
        shown: matches.length,
        cap: input.limit,
        guidance: `Showing ${matches.length} of ${total} ${category}. Pass a query to narrow, or raise limit (max 100).`,
      });
    }
    return {
      category,
      matches,
      ...(filterParam ? { filterParam } : {}),
      snapshotDate: ref.snapshotDate,
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines = [`Reference: ${result.category}`];
    for (const m of result.matches) {
      const extras = [
        m.formalName ? `formal: ${m.formalName}` : undefined,
        m.isoCode ? `ISO: ${m.isoCode}` : undefined,
        m.detail,
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(`- ${m.id} — ${m.title}${extras ? ` (${extras})` : ''}`);
    }
    if (result.filterParam)
      lines.push('', `Use these ids as find_stations \`${result.filterParam}\`.`);
    lines.push('', `Snapshot: ${result.snapshotDate}`, result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
