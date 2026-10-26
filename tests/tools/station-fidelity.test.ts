/**
 * @fileoverview Regression coverage for faithful connector, provider, and comment output.
 * @module tests/tools/station-fidelity
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, expect, it, vi } from 'vitest';
import { stationResource } from '@/mcp-server/resources/definitions/station.resource.js';
import { findStations } from '@/mcp-server/tools/definitions/find-stations.tool.js';
import { getStation } from '@/mcp-server/tools/definitions/get-station.tool.js';
import { getStationComments } from '@/mcp-server/tools/definitions/get-station-comments.tool.js';
import { buildReliabilityNote } from '@/services/openchargemap/attribution.js';
import { initOpenChargeMapService } from '@/services/openchargemap/openchargemap-service.js';
import { initReferenceDataService } from '@/services/reference-data/reference-data-service.js';
import { FULL_POI_DETAIL, jsonResponse } from '../fixtures/ocm.js';

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core/utils', async (actual) => ({
  ...(await actual<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout,
}));
const config = {
  apiKey: 'test',
  baseUrl: 'https://api.openchargemap.io/v3',
  referenceRefresh: false,
};
beforeEach(async () => {
  fetchWithTimeout.mockReset();
  await initReferenceDataService(config);
  initOpenChargeMapService(config);
});

it('characterizes full-set comment counts independent of the requested page', async () => {
  fetchWithTimeout.mockResolvedValue(jsonResponse([FULL_POI_DETAIL]));
  const result = await getStationComments.handler(
    getStationComments.input.parse({ id: 145452, maxresults: 1 }),
    createMockContext({ errors: getStationComments.errors }),
  );
  expect(result.totalComments).toBe(2);
  expect(result.comments).toHaveLength(1);
  expect(result.reliabilityNote).toContain('1 of 2');
  expect(result.comments[0]?.checkinStatusIsPositive).toBe(false);
});

it('preserves connector status, notes, and provider license on both contract surfaces', async () => {
  fetchWithTimeout.mockResolvedValue(
    jsonResponse([
      {
        ...FULL_POI_DETAIL,
        DataProvider: {
          Title: 'Provider',
          License: 'Open Government Licence v2.0',
          IsOpenDataLicensed: false,
        },
        Connections: [
          {
            StatusTypeID: 100,
            StatusType: { ID: 100, Title: 'Not Operational', IsOperational: false },
            Comments: 'Cable damaged',
          },
          {
            StatusTypeID: 30,
            StatusType: { ID: 30, Title: 'Temporarily Unavailable', IsOperational: true },
          },
          {
            StatusTypeID: 75,
            StatusType: { ID: 75, Title: 'Partly Operational (Mixed)', IsOperational: true },
          },
          { StatusType: null, StatusTypeID: null },
        ],
      },
    ]),
  );
  const result = await runToolContract(getStation, { id: 145452 });
  expect(result.structuredContent).toMatchObject({
    station: {
      dataProviderLicense: 'Open Government Licence v2.0',
      isOpenDataLicensed: false,
      connections: [
        {
          statusTypeId: 100,
          status: 'Not Operational',
          isOperational: false,
          notes: 'Cable damaged',
        },
        { statusTypeId: 30, isOperational: true },
        { statusTypeId: 75, isOperational: true },
        {},
      ],
    },
  });
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  for (const value of [
    'Cable damaged',
    'not usable right now',
    'only partly usable',
    'Open Government Licence v2.0',
    'open data licensed: no',
  ])
    expect(text).toContain(value);
  expect(text).not.toContain('CC BY 4.0');
});

it('renders every metadata-only comment row and keeps reliability dates independent of paging', async () => {
  fetchWithTimeout.mockResolvedValue(
    jsonResponse([
      {
        ...FULL_POI_DETAIL,
        UserComments: [
          {
            UserName: 'newest',
            CommentType: { Title: 'General Comment' },
            DateCreated: '2015-04-02T11:01:40Z',
          },
          {
            UserName: 'oldest',
            CommentType: { Title: 'Fault Report' },
            DateCreated: '2013-01-01T00:00:00Z',
          },
        ],
      },
    ]),
  );
  for (const maxresults of [1, 100]) {
    const result = await runToolContract(getStationComments, { id: 145452, maxresults });
    expect(result.structuredContent).toMatchObject({
      reliabilityNote: expect.stringContaining(
        '1 of 2 comment(s) on record report a fault or a failed visit (latest comment 2015-04-02)',
      ),
    });
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(text).toContain('[2015-04-02T11:01:40Z] newest (General Comment)');
    expect(text).not.toContain('not listed');
  }
  const detail = await runToolContract(getStation, { id: 145452, includeComments: true });
  expect(detail.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('newest (General Comment)') }),
    ]),
  );
});

it('renders metadata-only comments through both tools', async () => {
  fetchWithTimeout.mockResolvedValue(
    jsonResponse([
      {
        ...FULL_POI_DETAIL,
        UserComments: [
          {
            UserName: 'metadata',
            CommentType: { Title: 'General Comment' },
            DateCreated: '2022-12-01',
          },
        ],
      },
    ]),
  );
  const comments = await runToolContract(getStationComments, { id: 145452 });
  const detail = await runToolContract(getStation, { id: 145452, includeComments: true });
  for (const result of [comments, detail])
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('[2022-12-01] metadata (General Comment)'),
        }),
      ]),
    );
});

it.each([true, false, null, undefined])(
  'preserves provider flag %s without fabricating connector state or licensing',
  async (flag) => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse([
        {
          ...FULL_POI_DETAIL,
          DataProvider: { Title: 'Provider', License: '   ', IsOpenDataLicensed: flag },
          Connections: [{ StatusType: { IsOperational: null }, StatusTypeID: null }],
        },
      ]),
    );
    const result = await getStation.handler(
      getStation.input.parse({ id: 145452 }),
      createMockContext({ errors: getStation.errors }),
    );
    expect(result.station.connections).toEqual([{}]);
    expect(result.station.dataProviderLicense).toBeUndefined();
    expect(result.station.isOpenDataLicensed).toBe(typeof flag === 'boolean' ? flag : undefined);
    expect(getStation.format!(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Provider license: unspecified') }),
      ]),
    );
  },
);

it('shares connector and license normalization across search and resource', async () => {
  fetchWithTimeout.mockResolvedValue(
    jsonResponse([
      {
        ...FULL_POI_DETAIL,
        DataProvider: { Title: 'Provider', License: 'Provider terms', IsOpenDataLicensed: true },
        Connections: [{ StatusTypeID: 0, Comments: 'Connector note' }],
      },
    ]),
  );
  const search = await runToolContract(findStations, { latitude: 47.668, longitude: -122.387 });
  expect(search.structuredContent).toMatchObject({
    stations: [
      {
        dataProviderLicense: 'Provider terms',
        isOpenDataLicensed: true,
        connections: [{ statusTypeId: 0, notes: 'Connector note' }],
      },
    ],
  });
  expect(search.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('Connector note') }),
    ]),
  );
  const resource = await stationResource.handler(
    { id: '145452' },
    createMockContext({ errors: stationResource.errors }),
  );
  expect(resource.station).toMatchObject({
    dataProviderLicense: 'Provider terms',
    isOpenDataLicensed: true,
    connections: [{ statusTypeId: 0, notes: 'Connector note' }],
  });
});

it.each([{ extra: [] }, { extra: [{ dateCreated: 'invalid' }] }, { extra: [{}] }])(
  'omits latest-date prose when dates are unparseable: %j',
  ({ extra }) => {
    const note = buildReliabilityNote({
      status: undefined,
      isOperational: undefined,
      dateLastVerified: null,
      comments: [{ commentType: 'Fault Report' }, ...extra],
    });
    expect(note).toContain('on record');
    expect(note).not.toContain('latest comment');
    expect(note).not.toContain('recent comment');
  },
);
