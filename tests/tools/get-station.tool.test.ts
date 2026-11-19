/**
 * @fileoverview Tests for openchargemap_get_station — verbose detail fetch (headline goal),
 * the not_found empty-array case, inline comments + reliability note, sparse tolerance, and the
 * auth/unavailable error paths (fetch mock THROWS on non-OK).
 * @module tests/tools/get-station.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    withRetry: ((fn, options) =>
      fn({
        signal: options?.signal ?? new AbortController().signal,
        remainingMs: Number.POSITIVE_INFINITY,
      })) satisfies typeof actual.withRetry,
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
  CONTACT_POI_DETAIL,
  FULL_POI_DETAIL,
  LONDON_POI,
  PARTLY_OPERATIONAL_POI,
  PRIVATE_POI_DETAIL,
  SPARSE_POI,
  ZERO_COORD_POI,
  contentText,
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

/**
 * The recovery hint `errors[]` declares for a reason. A service throw carries only the reason; the
 * handler boundary (production, and `runToolContract`) fills this hint in from the contract.
 */
function declaredRecovery(reason: string): string {
  const hint = getStation.errors?.find((entry) => entry.reason === reason)?.recovery;
  if (!hint) throw new Error(`getStation declares no recovery for ${reason}`);
  return hint;
}

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
    expect(result.attribution).toContain('License terms vary by provider');
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

  it('flags a placeholder a few metres off 0,0 the same way search drops it', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        {
          ...ZERO_COORD_POI,
          AddressInfo: {
            ...ZERO_COORD_POI.AddressInfo,
            Latitude: -0.0000587,
            Longitude: -0.0000225,
          },
        },
      ]),
    );
    const result = await getStation.handler(getStation.input.parse({ id: 494804 }), ctx());
    expect(result.reliabilityNote).toContain('placeholder, not a real location');
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
    const result = await runToolContract(getStation, { id: 1 }, { context: { tenantId: 'test' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Unauthorized,
        data: {
          reason: 'auth_failed',
          retryable: false,
          recovery: { hint: declaredRecovery('auth_failed') },
        },
      },
    });
  });

  it('maps upstream failures to the service-unavailable error envelope', async () => {
    fetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'HTTP 503'),
    );
    const result = await runToolContract(getStation, { id: 1 }, { context: { tenantId: 'test' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_unavailable',
          retryable: true,
          recovery: { hint: declaredRecovery('upstream_unavailable') },
        },
      },
    });
  });

  it('hands the upstream Retry-After to the caller on both surfaces', async () => {
    // The shape fetchWithTimeout throws for a 429: the raw header value rides on data.retryAfter.
    fetchWithTimeout.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.RateLimited,
        'Fetch failed for https://api.openchargemap.io/v3/poi. Status: 429',
        { status: 429, retryAfter: '120' },
      ),
    );
    const result = await runToolContract(getStation, { id: 1 }, { context: { tenantId: 'test' } });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', retryable: true, retryAfter: '120' },
      },
    });
    const text = (result.content?.[0] as { text?: string } | undefined)?.text;
    expect(text).toContain('retry after `120`');
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
    expect(text).toContain('License terms vary by provider');
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
  it('keeps metadata-only comments on both output surfaces', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([BLANK_COMMENTS_POI]));
    const result = await getStation.handler(
      getStation.input.parse({ id: 71749, includeComments: true }),
      ctx(),
    );
    const text = (getStation.format!(result)[0] as { text: string }).text;

    expect(result.station.comments).toHaveLength(3); // nothing deleted from structuredContent
    expect(text).toContain('Comments:');
    expect(text.split('corscheg')).toHaveLength(4);
  });
});

// https://github.com/cyanheads/openchargemap-mcp-server/issues/38
// https://github.com/cyanheads/openchargemap-mcp-server/issues/39
describe('openchargemap_get_station contact fields and provider terms', () => {
  it('returns the site phone and related URL on both surfaces, the URL as a link', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([CONTACT_POI_DETAIL]));
    const result = await runToolContract(getStation, { id: 278317 });
    const text = contentText(result);

    expect(result.structuredContent).toMatchObject({
      station: {
        contactPhone: '877-455-3833',
        relatedUrl: 'https://www.evgo.com/',
        operatorWebsite: 'https://www.evgo.com/',
        dateCreated: '2023-09-28T05:34:00Z',
        usageTypeId: 1,
        dataProviderId: 1,
      },
    });
    expect(text).toContain('Contact phone: 877-455-3833');
    expect(text).toContain('Related URL: [https://www.evgo.com/](<https://www.evgo.com/>)');
    expect(text).toContain('Operator website: [https://www.evgo.com/](<https://www.evgo.com/>)');
    expect(text).toContain('Listing created: 2023-09-28T05:34:00Z');
    expect(text).toContain('Usage: Public (id 1)');
  });

  it('renders the operator phone, fault-report email, and secondary phone as plain text', async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        {
          ...LONDON_POI,
          AddressInfo: { ...LONDON_POI.AddressInfo, ContactTelephone2: '+44 (0)20 *ext* 7' },
        },
      ]),
    );
    const result = await runToolContract(getStation, { id: 67840 });
    const text = contentText(result);

    expect(result.structuredContent).toMatchObject({
      station: {
        contactPhoneSecondary: '+44 (0)20 *ext* 7',
        operatorPhone: '020 7247 4114',
        operatorFaultReportEmail: 'enquiries@pod-point.com',
        address: { line2: 'Soho' },
        usageCost: 'Free',
      },
    });
    expect(text).toContain('Secondary contact phone: +44 (0)20 \\*ext\\* 7');
    expect(text).toContain('Operator phone: 020 7247 4114');
    expect(text).toContain('Operator fault-report email: enquiries@pod-point.com');
    expect(text).toContain(
      'Operator website: [http://www.pod-point.com/](<http://www.pod-point.com/>)',
    );
    expect(text).toContain('19-25 Broadwick Street, Soho, London');
  });

  it('omits every phone, URL, and email for a private-individual station on both surfaces', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([PRIVATE_POI_DETAIL]));
    const result = await runToolContract(getStation, { id: 496719 });
    const serialized = JSON.stringify(result);

    for (const value of [
      '9802565500',
      'hyattplace.charlotte@dalyseven.com',
      'hyatt.com',
      'Contact phone',
      'Related URL',
    ])
      expect(serialized).not.toContain(value);
    expect(result.structuredContent).toMatchObject({
      station: { operatorId: 44, usageCost: '$.30 per KWh, plus $5 per hour idle fee' },
    });
  });

  it('renders the usage cost once, in the shared station block', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
    const text = contentText(await runToolContract(getStation, { id: 145452 }));

    expect(text.split('Usage cost:')).toHaveLength(2);
    expect(text).toContain('Usage cost: $0.30/kWh');
  });

  it('names the provider with its ID and keeps its license and open-data flag inline', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse([CONTACT_POI_DETAIL]));
    const text = contentText(await runToolContract(getStation, { id: 278317 }));

    expect(text).toContain(
      'Data provider: Open Charge Map Contributors (id 1)\nProvider license: Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)\nopen data licensed: yes',
    );
    expect(text).not.toContain('Data providers:');
  });
});
