/**
 * @fileoverview Tests for openchargemap_get_station_comments — comments + registry status header
 * (headline goal), empty-comments-is-not-an-error, the not_found case, maxresults trimming, and the
 * auth error path (fetch mock THROWS on non-OK).
 * @module tests/tools/get-station-comments.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    withRetry: (fn: () => unknown) => fn(),
  };
});

const { getStationComments } = await import(
  '@/mcp-server/tools/definitions/get-station-comments.tool.js'
);
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const { BLANK_COMMENTS_POI, FULL_POI, FULL_POI_DETAIL, jsonResponse } = await import(
  '../fixtures/ocm.js'
);

const serverConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};

beforeEach(async () => {
  fetchWithTimeout.mockReset();
  await initReferenceDataService(serverConfig);
  initOpenChargeMapService(serverConfig);
});

afterEach(() => vi.clearAllMocks());

const ctx = () => createMockContext({ tenantId: 'test', errors: getStationComments.errors });

describe('openchargemap_get_station_comments', () => {
  it.each([
    ['missing id', {}],
    ['zero id', { id: 0 }],
    ['negative id', { id: -1 }],
    ['fractional id', { id: 1.5 }],
    ['zero maxresults', { id: 1, maxresults: 0 }],
    ['maxresults above maximum', { id: 1, maxresults: 101 }],
    ['fractional maxresults', { id: 1, maxresults: 1.5 }],
  ])('rejects %s at the Zod boundary', (_label, input) => {
    expect(() => getStationComments.input.parse(input)).toThrow();
  });

  it('returns comments newest-first alongside the registry status header (headline goal)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      ctx(),
    );

    expect(result.stationId).toBe(145452);
    expect(result.registryStatus).toBe('Temporarily Unavailable');
    expect(result.isOperational).toBe(true);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]!.dateCreated).toBe('2025-06-01T10:00:00Z'); // newest first
    expect(result.reliabilityNote).toContain('fault');
    expect(result.attribution).toContain('CC BY 4.0');
    expect(result).toEqual(expect.schemaMatching(getStationComments.output));
  });

  it('returns comments: [] (not an error) for a station with no check-ins', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI])); // FULL_POI has no UserComments
    const c = ctx();
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      c,
    );

    expect(result.comments).toEqual([]);
    const enrichment = getEnrichment(c) as { notice?: string };
    expect(enrichment.notice).toContain('Absence of reports is not evidence');
  });

  it('trims to maxresults (newest first) and discloses truncation', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const c = ctx();
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452, maxresults: 1 }),
      c,
    );

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]!.dateCreated).toBe('2025-06-01T10:00:00Z');
    const enrichment = getEnrichment(c) as { truncated?: boolean; shown?: number; cap?: number };
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.cap).toBe(1);
  });

  it('always requests comments embedded in the POI (includecomments=true)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    await getStationComments.handler(getStationComments.input.parse({ id: 145452 }), ctx());
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('includecomments=true');
  });

  it('throws not_found for a non-existent station (empty array)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await expect(
      getStationComments.handler(getStationComments.input.parse({ id: 99999991 }), ctx()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
  });

  it('maps a 403 to auth_failed (fetch mock throws)', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Forbidden, 'HTTP 403'));
    await expect(
      getStationComments.handler(getStationComments.input.parse({ id: 1 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'auth_failed' },
    });
  });

  it('maps a 401 to auth_failed with recovery guidance', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Unauthorized, 'HTTP 401'));
    await expect(
      getStationComments.handler(getStationComments.input.parse({ id: 1 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: {
        reason: 'auth_failed',
        retryable: false,
        recovery: { hint: expect.any(String) },
      },
    });
  });

  it('maps upstream failures to the service-unavailable error envelope', async () => {
    fetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'HTTP 503'),
    );
    await expect(
      getStationComments.handler(getStationComments.input.parse({ id: 1 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        recovery: { hint: expect.any(String) },
      },
    });
  });

  it('formats the registry header, comments, reliability note, and attribution', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(text).toContain('AMLI Mark24');
    expect(text).toContain('Temporarily Unavailable');
    expect(text).toContain('Connector 1 would not start a session.');
    expect(text).toContain('Reliability:');
    expect(text).toContain('CC BY 4.0');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('preserves check-in outcomes and uses negative outcomes as fault signals', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(result.comments[0]).toMatchObject({
      checkinStatus: 'Failed to Charge (Equipment Not Operational)',
      checkinStatusId: 20,
    });
    expect(text).toContain('Failed to Charge (Equipment Not Operational)');
    expect(result.reliabilityNote).toContain('1 of 2');
    expect(result).toEqual(expect.schemaMatching(getStationComments.output));
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('counts a negative check-in filed under a general comment type as a fault', async () => {
    const generalFailure = {
      ...FULL_POI_DETAIL,
      UserComments: [
        {
          ID: 1,
          CommentType: { ID: 10, Title: 'General Comment' },
          CheckinStatusTypeID: 20,
          CheckinStatusType: {
            ID: 20,
            Title: 'Failed to Charge (Equipment Not Operational)',
            IsPositive: false,
          },
          UserName: 'evdriver3',
          Comment: null,
          Rating: null,
          DateCreated: '2025-06-02T10:00:00Z',
        },
      ],
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([generalFailure]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    // The old substring match on commentType saw only "General Comment" and counted nothing.
    expect(result.reliabilityNote).toContain('1 of 1');
    // The row's whole meaning is the outcome — it must not render as an empty line.
    expect(text).toContain('Failed to Charge (Equipment Not Operational)');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('names information-free comments instead of listing blank rows', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([BLANK_COMMENTS_POI]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 71749 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(result.comments).toHaveLength(3); // structured output keeps every row
    expect(text).toContain('3 comment(s), none carrying text');
    expect(text).not.toContain('corscheg');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('lists the rows that carry something and discloses the count of those that do not', async () => {
    const mixed = {
      ...BLANK_COMMENTS_POI,
      UserComments: [
        ...BLANK_COMMENTS_POI.UserComments!,
        {
          ID: 9,
          CommentType: { ID: 10, Title: 'General Comment' },
          UserName: 'evdriver9',
          Comment: 'Two stalls, both free.',
          Rating: 5,
          DateCreated: '2025-01-01T00:00:00Z',
        },
      ],
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([mixed]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 71749 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(result.comments).toHaveLength(4);
    expect(text).toContain('Two stalls, both free.');
    expect(text).toContain('(3 not listed — no text, rating, or check-in outcome)');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('never omits a row the reliability note counts as a fault', async () => {
    const bareFaultReport = {
      ...BLANK_COMMENTS_POI,
      UserComments: [
        {
          ID: 1,
          CommentType: { ID: 1000, Title: 'Fault Report (Notice To Users And Operator)' },
          UserName: 'evdriver4',
          Comment: null,
          Rating: null,
          DateCreated: '2025-06-01T00:00:00Z',
        },
      ],
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([bareFaultReport]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 71749 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(result.reliabilityNote).toContain('1 of 1');
    expect(text).toContain('Fault Report (Notice To Users And Operator)');
    expect(text).not.toContain('not listed');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('keeps a row whose only content is the link the commenter attached', async () => {
    const linkOnly = {
      ...BLANK_COMMENTS_POI,
      UserComments: [
        {
          ID: 1,
          CommentType: { ID: 10, Title: 'General Comment' },
          UserName: 'evdriver5',
          Comment: null,
          Rating: null,
          RelatedURL: 'https://example.com/outage-notice',
          DateCreated: '2025-06-01T00:00:00Z',
        },
      ],
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([linkOnly]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 71749 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(text).toContain('https://example.com/outage-notice');
    expect(text).not.toContain('not listed');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('renders a text-free check-in without a dangling separator', async () => {
    const outcomeOnly = {
      ...BLANK_COMMENTS_POI,
      UserComments: [
        {
          ID: 1,
          CommentType: { ID: 10, Title: 'General Comment' },
          CheckinStatusTypeID: 10,
          CheckinStatusType: { ID: 10, Title: 'Charged Successfully', IsPositive: true },
          UserName: 'evdriver6',
          Comment: '',
          Rating: 4,
          DateCreated: '2025-06-01T00:00:00Z',
        },
      ],
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([outcomeOnly]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 71749 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(text).toContain(
      '- [2025-06-01T00:00:00Z] evdriver6 (General Comment, ★4, Charged Successfully #10, good visit: yes)',
    );
    expect(text).not.toMatch(/\):\s*$/m);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('does not call a Temporarily Unavailable station operational', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStationComments.handler(
      getStationComments.input.parse({ id: 145452 }),
      ctx(),
    );
    const text = (getStationComments.format!(result)[0] as { text: string }).text;

    expect(text).not.toContain('Temporarily Unavailable (operational)');
    expect(text).toContain('not usable right now');
    expect(result.registryStatusId).toBe(30);
    expect(result.isOperational).toBe(true); // upstream value preserved
    expect(result.reliabilityNote).toContain('not usable right now');
  });
});
