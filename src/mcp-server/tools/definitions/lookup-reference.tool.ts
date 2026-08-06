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
    'Resolve Open Charge Map reference data to the integer IDs that openchargemap_find_stations filters require. Pick a category and pass a name or code to resolve — "CCS" or "Tesla Supercharger" -> a connectiontypeid, "ChargePoint" -> an operatorid, "Public - Pay At Location" -> a usagetypeid, "France" or "FR" -> a country. Omit the query to browse the whole category. Large categories come back one page at a time: when a page reports truncated, repeat the call with the reported nextOffset to read the next one.',
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
      .regex(/\S/, 'query must contain at least one non-whitespace character')
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Entries to skip before the returned page, for reading past a truncated result. Repeat the same call with the nextOffset value the previous one reported. Applies to browsing and to a query with many matches alike; the order is stable, so every entry is reachable by paging.',
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
        'Date the reference data in this response was captured, so callers know its vintage — the day the live refresh ran when source is "live", the bundled snapshot\'s own capture date when source is "bundled". Read it together with source: the same date can mean either a fresh fetch or a freshly cut bundle.',
      ),
    source: z
      .enum(['live', 'bundled'])
      .describe(
        'Where these entries came from. "live" — a startup refresh from Open Charge Map returned a complete set and is what is being served. "bundled" — the snapshot shipped with the server is being served, either because the refresh is switched off or because it failed and the server fell back to the bundle.',
      ),
    attribution: z
      .string()
      .describe('Required CC BY 4.0 attribution to Open Charge Map contributors.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Entries matching before the offset/limit page was taken — the whole category when browsing, every match when a query was given.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when matching entries were left out of the returned page.'),
    shown: z.number().optional().describe('Entries in the returned page.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'The offset to pass on an otherwise identical call to read the next page. Absent on the last page.',
      ),
    notice: z.string().optional().describe('How to reach the entries this page left out.'),
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

    const { matches, total } =
      input.query === undefined
        ? ref.browse(category, input.limit, input.offset)
        : ref.resolve(category, input.query, input.limit, input.offset);

    if (input.query !== undefined && total === 0) {
      throw ctx.fail('no_match', `No ${category} entry matched "${input.query}".`, {
        ...ctx.recoveryFor('no_match'),
      });
    }

    ctx.enrich.total(total);
    const remaining = total - (input.offset + matches.length);
    if (remaining > 0) {
      ctx.enrich.truncated({
        shown: matches.length,
        cap: input.limit,
        guidance: `Showing ${matches.length} of ${total} ${category} from offset ${input.offset}. Pass offset ${input.offset + matches.length} on the same call for the next ${input.limit}${input.query === undefined ? ', or pass a query to narrow' : ''}.`,
      });
      ctx.enrich({ nextOffset: input.offset + matches.length });
    } else if (matches.length === 0) {
      ctx.enrich.notice(
        `This call matched ${total} ${category}, so offset ${input.offset} is past the end. Lower offset to read them.`,
      );
    }

    return {
      category,
      matches,
      ...(filterParam ? { filterParam } : {}),
      snapshotDate: ref.snapshotDate,
      source: ref.source,
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
    lines.push(
      '',
      `Reference data: ${result.source} (captured ${result.snapshotDate})`,
      result.attribution,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
