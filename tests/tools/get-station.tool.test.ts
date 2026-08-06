/**
 * @fileoverview Tests for openchargemap_get_station — verbose detail fetch (headline goal),
 * the not_found empty-array case, inline comments + reliability note, sparse tolerance, and the
 * auth/unavailable error paths (fetch mock THROWS on non-OK).
 * @module tests/tools/get-station.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

const { getStation } = await import('@/mcp-server/tools/definitions/get-station.tool.js');
const { initReferenceDataService } = await import(
  '@/services/reference-data/reference-data-service.js'
);
const { initOpenChargeMapService } = await import(
  '@/services/openchargemap/openchargemap-service.js'
);
const {
  BLANK_COMMENTS_POI,
  FULL_POI_DETAIL,
  PARTLY_OPERATIONAL_POI,
  SPARSE_POI,
  ZERO_COORD_POI,
  jsonResponse,
} = await import('../fixtures/ocm.js');

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

const ctx = () => createMockContext({ tenantId: 'test', errors: getStation.errors });

describe('openchargemap_get_station', () => {
  it.each([
    ['missing id', {}],
    ['zero id', { id: 0 }],
    ['negative id', { id: -1 }],
    ['fractional id', { id: 1.5 }],
    ['string id', { id: '145452' }],
    ['invalid includeComments', { id: 145452, includeComments: 'true' }],
  ])('rejects %s at the Zod boundary', (_label, input) => {
    expect(() => getStation.input.parse(input)).toThrow();
  });

  it('returns the full detail record for a numeric id (headline goal)', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());

    expect(result.station.id).toBe(145452);
    expect(result.station.generalComments).toBe('Located in the parking garage, level P1.');
    expect(result.station.usageCost).toBe('$0.30/kWh');
    expect(result.station.numberOfPoints).toBe(2);
    expect(result.station.media?.[0]?.url).toBe('https://example.com/photo.jpg');
    expect(result.attribution).toContain('CC BY 4.0');
    expect(result).toEqual(expect.schemaMatching(getStation.output));
  });

  it('uses verbose=true on the detail request', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('verbose=true');
    expect(String(url)).toContain('chargepointid=145452');
  });

  it('includes comments inline and computes a reliability note when faults are present', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(
      getStation.input.parse({ id: 145452, includeComments: true }),
      ctx(),
    );

    expect(result.station.comments).toHaveLength(2);
    // Newest first.
    expect(result.station.comments?.[0]?.dateCreated).toBe('2025-06-01T10:00:00Z');
    expect(result.reliabilityNote).toContain('fault');
    const [url] = fetchWithTimeout.mock.calls[0]!;
    expect(String(url)).toContain('includecomments=true');
  });

  it('throws not_found when OCM returns an empty array (HTTP 200 + [])', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([]));
    await expect(
      getStation.handler(getStation.input.parse({ id: 99999991 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('tolerates a sparse detail payload and validates against the output schema', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([SPARSE_POI]));
    const result = await getStation.handler(getStation.input.parse({ id: 253415 }), ctx());
    expect(result.station.isOperational).toBeUndefined();
    expect(result.station.generalComments).toBeUndefined();
    expect(result).toEqual(expect.schemaMatching(getStation.output));
  });

  it('keeps a 0,0 record on direct lookup and flags the coordinate in the reliability note', async () => {
    // Direct ID lookup must NOT filter 0,0 (unlike search) — the record is a fact about that station.
    fetchWithTimeout.mockResolvedValue(jsonResponse([ZERO_COORD_POI]));
    const result = await getStation.handler(getStation.input.parse({ id: 494804 }), ctx());
    expect(result.station.id).toBe(494804); // not filtered out
    expect(result.station.address.latitude).toBe(0);
    expect(result.station.address.longitude).toBe(0);
    expect(result.reliabilityNote).toContain('0,0'); // coordinate caveat surfaced
  });

  it('maps a 403 to auth_failed (fetch mock throws)', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Forbidden, 'HTTP 403'));
    await expect(
      getStation.handler(getStation.input.parse({ id: 1 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'auth_failed' },
    });
  });

  it('maps a 401 to auth_failed with recovery guidance', async () => {
    fetchWithTimeout.mockRejectedValue(new McpError(JsonRpcErrorCode.Unauthorized, 'HTTP 401'));
    await expect(
      getStation.handler(getStation.input.parse({ id: 1 }), ctx()),
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
      getStation.handler(getStation.input.parse({ id: 1 }), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        recovery: { hint: expect.any(String) },
      },
    });
  });

  it('format() renders detail fields, comments, and reliability note', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(
      getStation.input.parse({ id: 145452, includeComments: true }),
      ctx(),
    );
    const text = (getStation.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Usage cost: $0.30/kWh');
    expect(text).toContain('Reliability:');
    expect(text).toContain('CC BY 4.0');
  });

  it('omits comments from structured and text output when not requested', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(result.station.comments).toBeUndefined();
    expect(text).not.toContain('Comments:');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/4
  it('renders explicit false access and verification flags in text output', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(text).toContain('pay at location: no');
    expect(text).toContain('membership required: no');
    expect(text).toContain('access key required: no');
    expect(text).toContain('recently verified: no');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/4
  it('renders true access flags as an explicit yes', async () => {
    const restricted = {
      ...FULL_POI_DETAIL,
      UsageType: {
        ID: 4,
        Title: 'Public - Membership Required',
        IsPayAtLocation: false,
        IsMembershipRequired: true,
        IsAccessKeyRequired: true,
      },
      IsRecentlyVerified: true,
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([restricted]));
    const result = await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(text).toContain(
      'pay at location: no, membership required: yes, access key required: yes',
    );
    expect(text).toContain('recently verified: yes');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/4
  it('leaves absent flags out of the text rather than rendering them as no', async () => {
    // SPARSE_POI has no UsageType and no IsRecentlyVerified — unknown, not false.
    fetchWithTimeout.mockResolvedValue(jsonResponse([SPARSE_POI]));
    const result = await getStation.handler(getStation.input.parse({ id: 253415 }), ctx());
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(result.station.isPayAtLocation).toBeUndefined();
    expect(text).not.toContain('pay at location');
    expect(text).not.toContain('membership required');
    expect(text).not.toContain('access key required');
    expect(text).not.toContain('recently verified');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('does not render Temporarily Unavailable as operational', async () => {
    const freshUnavailable = {
      ...FULL_POI_DETAIL,
      DateLastVerified: '2026-08-01T00:00:00Z',
    };
    fetchWithTimeout.mockResolvedValue(jsonResponse([freshUnavailable]));
    const result = await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(text).not.toContain('Temporarily Unavailable (operational)');
    expect(text).toContain('not usable right now');
    expect(result.reliabilityNote).toContain('Temporarily Unavailable');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('keeps isOperational as the faithful upstream value and exposes the status id', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(getStation.input.parse({ id: 145452 }), ctx());

    expect(result.station.isOperational).toBe(true); // OCM says so; the derived judgment is prose
    expect(result.station.statusTypeId).toBe(30);
    expect((getStation.format!(result)[0] as { text: string }).text).toContain(
      'operational flag: yes',
    );
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/10
  it('flags a partly-operational station without calling it unusable', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([PARTLY_OPERATIONAL_POI]));
    const result = await getStation.handler(getStation.input.parse({ id: 300001 }), ctx());
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(result.station.statusTypeId).toBe(75);
    expect(text).toContain('only partly usable');
    expect(result.reliabilityNote).toContain('only some equipment here is working');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('preserves and renders OCM check-in outcomes', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const result = await getStation.handler(
      getStation.input.parse({ id: 145452, includeComments: true }),
      ctx(),
    );
    const comments = result.station.comments;
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(comments?.[0]).toMatchObject({
      checkinStatus: 'Failed to Charge (Equipment Not Operational)',
      checkinStatusId: 20,
      relatedUrl: 'https://example.com/outage',
    });
    expect(text).toContain('Failed to Charge (Equipment Not Operational)');
    expect(text).toContain('https://example.com/outage');
    expect(result).toEqual(expect.schemaMatching(getStation.output));
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/9
  it('keeps information-free comments in the structured output but not in the text list', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([BLANK_COMMENTS_POI]));
    const result = await getStation.handler(
      getStation.input.parse({ id: 71749, includeComments: true }),
      ctx(),
    );
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(result.station.comments).toHaveLength(3); // nothing deleted from structuredContent
    expect(text).toContain('Comments: 3 on record, none carrying text');
    expect(text).not.toContain('corscheg');
  });
});
