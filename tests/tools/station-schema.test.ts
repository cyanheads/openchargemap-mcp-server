/**
 * @fileoverview Unit tests for the shared station/comment renderers in `_station-schema.ts`.
 * These are pure functions feeding every tool's `format()` output, so they are pinned here
 * rather than only through a handler.
 * @module tests/tools/station-schema
 */

import { describe, expect, it } from 'vitest';
import {
  renderComment,
  renderStationBlock,
  renderStationPage,
  type Station,
} from '@/mcp-server/tools/definitions/_station-schema.js';

describe('renderComment', () => {
  const URL = 'https://forum.example.it/t46938.html';

  it('renders an attached link once when the comment text already carries it', () => {
    const line = renderComment({
      user: 'driver',
      comment: `Great spot. Full review here: ${URL}`,
      relatedUrl: URL,
    });

    expect(line.split(URL)).toHaveLength(2); // exactly one occurrence
    expect(line).toBe(`driver: Great spot. Full review here: ${URL}`);
  });

  it('appends an attached link the comment text does not carry', () => {
    const line = renderComment({ user: 'driver', comment: 'Charger was dead.', relatedUrl: URL });

    expect(line).toBe(`driver: Charger was dead. [${URL}](<${URL}>)`);
  });

  it('renders an attached link with no comment text', () => {
    const line = renderComment({ user: 'driver', relatedUrl: URL });

    expect(line).toBe(`driver: [${URL}](<${URL}>)`);
  });

  it('leaves no dangling separator when there is neither text nor link', () => {
    const line = renderComment({ user: 'driver', checkinStatus: 'Charged Successfully' });

    expect(line).toBe('driver (Charged Successfully)');
    expect(line.endsWith(':')).toBe(false);
  });

  it('keeps commenter Markdown literal and renders unsafe link schemes as text', () => {
    expect(
      renderComment({
        user: '*driver*',
        comment: '[free](https://fake.test)',
        relatedUrl: 'javascript:alert(1)',
      }),
    ).toBe('\\*driver\\*: \\[free\\](https://fake.test) javascript:alert(1) (javascript:alert(1))');
  });
});

/** A station carrying no provider ID, usage type ID, usage cost, or second address line. */
const BASE: Station = {
  id: 145452,
  uuid: 'U-1',
  title: 'AMLI Mark24',
  address: {
    line1: '2229 5th Ave',
    town: 'Seattle',
    stateOrProvince: 'Washington',
    postcode: '98121',
    country: 'United States',
    countryCode: 'US',
    latitude: 47.668,
    longitude: -122.387,
    accessComments: '24 hours daily',
  },
  distance: 0.1445,
  distanceUnit: 'KM',
  operator: 'ChargePoint',
  operatorId: 5,
  usageType: 'Public',
  isPayAtLocation: false,
  isMembershipRequired: false,
  isAccessKeyRequired: false,
  numberOfPoints: 2,
  status: 'Operational',
  statusTypeId: 50,
  isOperational: true,
  dateLastVerified: '2025-06-24T08:14:00Z',
  isRecentlyVerified: false,
  connections: [{ connectionType: 'CCS (Type 1)', connectionTypeId: 32, powerKW: 50, quantity: 2 }],
  dataProvider: 'afdc.energy.gov',
  dataProviderLicense: 'Public domain',
  isOpenDataLicensed: true,
};

/** A minimal station: only the required fields, plus whatever the case under test adds. */
function bareStation(extra: Partial<Station> = {}): Station {
  return {
    id: 1,
    uuid: 'U-bare',
    title: 'Bare',
    address: { latitude: 1, longitude: 2 },
    connections: [],
    ...extra,
  };
}

describe('renderStationBlock', () => {
  it('renders a station without the newer optional fields exactly as before', () => {
    expect(renderStationBlock(BASE)).toBe(
      [
        '**AMLI Mark24** — 0.14 KM  _(id 145452, uuid U-1)_',
        '2229 5th Ave, Seattle, Washington, 98121, United States, (US)',
        'Coordinates: 47.668, -122.387',
        'Access: 24 hours daily',
        'Operator: ChargePoint (id 5) · Usage: Public · pay at location: no, membership required: no, access key required: no',
        'Charge points: 2',
        'Data provider: afdc.energy.gov',
        'Provider license: Public domain',
        'open data licensed: yes',
        'Connections:',
        '  - CCS (Type 1) · typeId 32 · 50 kW ×2',
        'Status: Operational (status id 50) — operational · last verified 2025-06-24T08:14:00Z (recently verified: no)',
      ].join('\n'),
    );
  });

  it('renders address line 2, the usage type ID, the usage cost, and the provider ID', () => {
    const block = renderStationBlock({
      ...BASE,
      address: { ...BASE.address, line2: 'Soho' },
      usageTypeId: 1,
      usageCost: '£0.45/kWh *peak*',
      dataProviderId: 2,
    });

    expect(block).toContain('2229 5th Ave, Soho, Seattle,');
    expect(block).toContain('Usage: Public (id 1)');
    expect(block).toContain('Usage cost: £0.45/kWh \\*peak\\*');
    expect(block).toContain('Data provider: afdc.energy.gov (id 2)');
    // A detail block keeps its provider's terms inline.
    expect(block).toContain('Provider license: Public domain');
    expect(block).toContain('open data licensed: yes');
  });

  it('renders each ID on its own when OCM gave no title beside it, including ID 0', () => {
    const block = renderStationBlock(
      bareStation({ operatorId: 3, usageTypeId: 0, dataProviderId: 7 }),
    );

    expect(block).toContain('Operator: id 3');
    expect(block).toContain('Usage: id 0');
    expect(block).toContain('Data provider: id 7');
  });

  it('leaves the usage cost and provider lines out when OCM has none on record', () => {
    const block = renderStationBlock(bareStation());

    expect(block).not.toContain('Usage cost');
    expect(block).not.toContain('Data provider');
    expect(block).not.toContain('Usage:');
    expect(block).toContain('Provider license: unspecified');
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/37
  it("renders a route search station's two positions under its title, in the station's unit", () => {
    const block = renderStationBlock(
      bareStation({ distanceUnit: 'Miles', routeDistance: 41.74, offRouteDistance: 2.91 }),
    );

    expect(block.split('\n').slice(0, 2)).toEqual([
      '**Bare**  _(id 1, uuid U-bare)_',
      'Route: 41.74 Miles along, 2.91 Miles off it',
    ]);
    expect(renderStationBlock(BASE)).not.toContain('Route:');
  });
});

describe('renderStationPage', () => {
  const AFDC =
    'This data is provided by the National Renewable Energy Laboratory ("NREL"), which is operated by the Alliance for Sustainable Energy, LLC ("Alliance"), for the U.S. Department of Energy ("DOE"), and may be used for any purpose whatsoever.';

  const afdcStation = (id: number): Station =>
    bareStation({
      id,
      title: `AFDC ${id}`,
      dataProvider: 'afdc.energy.gov',
      dataProviderId: 2,
      dataProviderLicense: AFDC,
      isOpenDataLicensed: true,
    });

  it('renders each provider license once per page, after the stations', () => {
    const blocks = renderStationPage([afdcStation(1), afdcStation(2), afdcStation(3)]);
    const text = blocks.join('\n\n');

    expect(blocks).toHaveLength(4);
    expect(text.split(AFDC)).toHaveLength(2);
    expect(blocks[3]).toBe(
      `Data providers:\n  - afdc.energy.gov (id 2) · open data licensed: yes · Provider license: ${AFDC}`,
    );
    for (const block of blocks.slice(0, 3)) {
      expect(block).toContain('Data provider: afdc.energy.gov (id 2)');
      expect(block).not.toContain('Provider license');
      expect(block).not.toContain('open data licensed');
    }
  });

  it('keys providers by ID, so two providers sharing a title keep their own terms', () => {
    const blocks = renderStationPage([
      bareStation({
        id: 10,
        dataProvider: 'Petite Borne',
        dataProviderId: 62,
        dataProviderLicense: 'Licensed under CC0 by data sharing agreement',
        isOpenDataLicensed: true,
      }),
      bareStation({
        id: 11,
        dataProvider: 'Petite Borne',
        dataProviderId: 120,
        dataProviderLicense: 'CC0',
        isOpenDataLicensed: false,
      }),
    ]);

    expect(blocks[0]).toContain('Data provider: Petite Borne (id 62)');
    expect(blocks[1]).toContain('Data provider: Petite Borne (id 120)');
    expect(blocks[2]).toBe(
      [
        'Data providers:',
        '  - Petite Borne (id 62) · open data licensed: yes · Provider license: Licensed under CC0 by data sharing agreement',
        '  - Petite Borne (id 120) · open data licensed: no · Provider license: CC0',
      ].join('\n'),
    );
  });

  it('keeps the terms inline for a station without a provider ID', () => {
    const blocks = renderStationPage([
      bareStation({ dataProvider: 'Unkeyed', dataProviderLicense: 'Unkeyed terms' }),
      bareStation({ id: 2, dataProvider: 'No terms at all' }),
    ]);

    expect(blocks).toHaveLength(2); // no page-level block when no station carries a provider ID
    expect(blocks[0]).toContain('Provider license: Unkeyed terms');
    expect(blocks[1]).toContain('Provider license: unspecified');
  });

  it('keeps a station inline when its terms differ from the entry already listed under its ID', () => {
    const blocks = renderStationPage([
      bareStation({ id: 1, dataProviderId: 9, dataProviderLicense: 'First terms' }),
      bareStation({ id: 2, dataProviderId: 9, dataProviderLicense: 'Second terms' }),
      bareStation({ id: 3, dataProviderId: 9, dataProviderLicense: 'First terms' }),
    ]);

    expect(blocks[0]).not.toContain('Provider license');
    expect(blocks[1]).toContain('Provider license: Second terms');
    expect(blocks[2]).not.toContain('Provider license');
    expect(blocks[3]).toBe('Data providers:\n  - id 9 · Provider license: First terms');
  });

  it('keeps a station inline when only its open-data flag differs from the listed entry', () => {
    const terms = { dataProviderId: 9, dataProviderLicense: 'Shared terms' };
    const blocks = renderStationPage([
      bareStation({ id: 1, ...terms, isOpenDataLicensed: true }),
      bareStation({ id: 2, ...terms, isOpenDataLicensed: false }),
      bareStation({ id: 3, ...terms }),
    ]);

    expect(blocks[0]).not.toContain('Provider license');
    expect(blocks[1]).toContain('Provider license: Shared terms\nopen data licensed: no');
    expect(blocks[2]).toContain('Provider license: Shared terms');
    expect(blocks[2]).not.toContain('open data licensed');
    expect(blocks[3]).toBe(
      'Data providers:\n  - id 9 · open data licensed: yes · Provider license: Shared terms',
    );
  });

  it('marks an absent license as unspecified and leaves an unknown open-data flag out', () => {
    const blocks = renderStationPage([bareStation({ dataProvider: 'Quiet', dataProviderId: 4 })]);

    expect(blocks[1]).toBe('Data providers:\n  - Quiet (id 4) · Provider license: unspecified');
  });

  it('returns no blocks for an empty page', () => {
    expect(renderStationPage([])).toEqual([]);
  });
});
