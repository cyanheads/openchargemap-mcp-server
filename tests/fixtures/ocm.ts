/**
 * @fileoverview Shared OCM POI fixtures for tool tests — a full station, a sparse station (omitted
 * upstream fields, absent StatusType key), a station with comments, a partly-operational station,
 * a station whose entire comment list carries only metadata, a 0,0-coordinate station, and real
 * captured records carrying site and operator contact fields, including one under the
 * private-individual operator.
 * @module tests/fixtures/ocm
 */

import type { RawPoi } from '@/services/openchargemap/types.js';

/** A fully-populated station (Seattle, ChargePoint, Temporarily Unavailable but IsOperational:true). */
export const FULL_POI = {
  ID: 145452,
  UUID: '3054F576-5C0C-4FAB-A920-F06AA3EE743A',
  OperatorID: 5,
  UsageTypeID: 1,
  StatusTypeID: 30,
  DateLastVerified: '2025-06-24T08:14:00Z',
  IsRecentlyVerified: false,
  OperatorInfo: { ID: 5, Title: 'ChargePoint' },
  UsageType: {
    ID: 1,
    Title: 'Public',
    IsPayAtLocation: false,
    IsMembershipRequired: false,
    IsAccessKeyRequired: false,
  },
  StatusType: { ID: 30, Title: 'Temporarily Unavailable', IsOperational: true },
  DataProvider: { ID: 2, Title: 'afdc.energy.gov', WebsiteURL: 'http://www.afdc.energy.gov/' },
  AddressInfo: {
    ID: 1,
    Title: 'AMLI Mark24',
    AddressLine1: '2229 5th Ave',
    Town: 'Seattle',
    StateOrProvince: 'Washington',
    Postcode: '98121',
    Country: { ISOCode: 'US', Title: 'United States', ContinentCode: 'NA' },
    Latitude: 47.668,
    Longitude: -122.387,
    Distance: 0.1445,
    DistanceUnit: 1,
    AccessComments: '24 hours daily',
  },
  Connections: [
    {
      ID: 202127,
      ConnectionTypeID: 1,
      ConnectionType: { ID: 1, Title: 'Type 1 (J1772)', FormalName: 'SAE J1772-2009' },
      LevelID: 2,
      Level: { ID: 2, Title: 'Level 2 : Medium (Over 2kW)' },
      Amps: 16,
      Voltage: 230,
      PowerKW: 3.7,
      CurrentTypeID: 10,
      CurrentType: { ID: 10, Title: 'AC (Single-Phase)' },
      Quantity: 2,
    },
  ],
} satisfies RawPoi;

/** Detail-only fields layered on FULL_POI for verbose=true responses. */
export const FULL_POI_DETAIL = {
  ...FULL_POI,
  NumberOfPoints: 2,
  UsageCost: '$0.30/kWh',
  GeneralComments: 'Located in the parking garage, level P1.',
  DateLastStatusUpdate: '2025-06-24T08:14:00Z',
  SubmissionStatus: { ID: 100, Title: 'Imported and Published' },
  MediaItems: [{ ItemURL: 'https://example.com/photo.jpg', Comment: 'Entrance' }],
  UserComments: [
    {
      ID: 1,
      CommentType: { ID: 10, Title: 'General Comment' },
      CheckinStatusTypeID: 10,
      CheckinStatusType: { ID: 10, Title: 'Charged Successfully', IsPositive: true },
      UserName: 'evdriver1',
      Comment: 'Worked fine, two stalls open.',
      Rating: 5,
      DateCreated: '2025-05-01T10:00:00Z',
    },
    {
      ID: 2,
      CommentType: { ID: 30, Title: 'Fault Report' },
      CheckinStatusTypeID: 20,
      CheckinStatusType: {
        ID: 20,
        Title: 'Failed to Charge (Equipment Not Operational)',
        IsPositive: false,
      },
      UserName: 'evdriver2',
      Comment: 'Connector 1 would not start a session.',
      Rating: 2,
      RelatedURL: 'https://example.com/outage',
      DateCreated: '2025-06-01T10:00:00Z',
    },
  ],
} satisfies RawPoi;

/**
 * A station whose whole comment list carries only metadata — OCM stores runs of check-ins with a
 * null Comment, null Rating, and no CheckinStatusType (verified on real records).
 */
export const BLANK_COMMENTS_POI = {
  ...FULL_POI,
  ID: 71749,
  StatusTypeID: 50,
  StatusType: { ID: 50, Title: 'Operational', IsOperational: true },
  UserComments: [1, 2, 3].map((n) => ({
    ID: n,
    CommentType: { ID: 10, Title: 'General Comment' },
    CheckinStatusTypeID: null,
    CheckinStatusType: null,
    UserName: 'corscheg',
    Comment: null,
    Rating: null,
    DateCreated: `2024-0${n}-01T00:00:00Z`,
  })),
} satisfies RawPoi;

/**
 * A partly-operational station (StatusType 75) — OCM flags it operational, but only some of the
 * equipment on site works.
 */
export const PARTLY_OPERATIONAL_POI = {
  ...FULL_POI,
  ID: 300001,
  StatusTypeID: 75,
  StatusType: { ID: 75, Title: 'Partly Operational (Mixed)', IsOperational: true },
  DateLastVerified: '2026-08-01T00:00:00Z',
} satisfies RawPoi;

/**
 * A sparse station — omits NumberOfPoints/UsageCost/GeneralComments, has NO StatusType key at all
 * (verified to happen on real records), null connection power, no operator.
 */
export const SPARSE_POI = {
  ID: 253415,
  UUID: 'AAAA1111-2222-3333-4444-555566667777',
  DateLastVerified: null,
  AddressInfo: {
    ID: 2,
    Title: 'Unknown lot',
    Latitude: 51.5,
    Longitude: -0.12,
    // no Distance/DistanceUnit (as in a bbox search), no country
  },
  Connections: [
    {
      ID: 9,
      ConnectionTypeID: 25,
      ConnectionType: { ID: 25, Title: 'Type 2 (Socket Only)' },
      PowerKW: null,
      Amps: null,
      Voltage: null,
      Quantity: null,
    },
  ],
  // StatusType key entirely absent; UsageType absent; OperatorInfo absent; MediaItems absent.
} satisfies RawPoi;

/**
 * A real-looking US station that OCM stores at the 0,0 sentinel (open ocean, Gulf of Guinea) — a
 * systemic data-quality pattern, not a real location. A proximity search must drop it; a direct
 * ID lookup keeps it but flags the coordinate.
 */
export const ZERO_COORD_POI = {
  ID: 494804,
  UUID: 'ZZZZ0000-0000-0000-0000-000000000000',
  OperatorID: 5,
  StatusTypeID: 50,
  DateLastVerified: '2025-06-01T00:00:00Z',
  IsRecentlyVerified: true,
  StatusType: { ID: 50, Title: 'Operational', IsOperational: true },
  AddressInfo: {
    ID: 3,
    Title: 'Tanluzhe Showroom/Test Location',
    AddressLine1: '123 Industrial Way',
    Town: 'San Jose',
    StateOrProvince: 'California',
    Postcode: '95112',
    Country: { ISOCode: 'US', Title: 'United States', ContinentCode: 'NA' },
    Latitude: 0,
    Longitude: 0,
    Distance: 0,
    DistanceUnit: 1,
  },
  Connections: [
    {
      ID: 1,
      ConnectionTypeID: 27,
      ConnectionType: { ID: 27, Title: 'NACS / Tesla Supercharger' },
      Quantity: 4,
    },
  ],
} satisfies RawPoi;

/**
 * Station 278317 as OCM returns it (captured 2026-11-19): a site phone and a related URL on a
 * network operator whose `IsPrivateIndividual` is false. No `UsageCost`, no operator phone.
 */
export const CONTACT_POI_DETAIL = {
  ID: 278317,
  UUID: '30DABD59-C2D8-48D2-8B6B-A36F57194602',
  DateCreated: '2023-09-28T05:34:00Z',
  OperatorID: 15,
  UsageTypeID: 1,
  StatusTypeID: 50,
  DataProviderID: 1,
  DateLastVerified: '2026-08-01T00:00:00Z',
  OperatorInfo: {
    ID: 15,
    Title: 'eVgo Network',
    WebsiteURL: 'https://www.evgo.com/',
    IsPrivateIndividual: false,
  },
  UsageType: {
    ID: 1,
    Title: 'Public',
    IsPayAtLocation: false,
    IsMembershipRequired: false,
    IsAccessKeyRequired: false,
  },
  StatusType: { ID: 50, Title: 'Operational', IsOperational: true },
  DataProvider: {
    ID: 1,
    Title: 'Open Charge Map Contributors',
    License: 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)',
    IsOpenDataLicensed: true,
  },
  AddressInfo: {
    ID: 278704,
    Title: 'Safeway Seattle #1143 - 8340 15th Ave Nw',
    AddressLine1: '8340 15th Ave NW',
    Town: 'Seattle',
    StateOrProvince: 'WA',
    Postcode: '98117',
    Latitude: 47.689356,
    Longitude: -122.37659,
    ContactTelephone1: '877-455-3833',
    RelatedURL: 'https://www.evgo.com/',
    AccessComments: '24 hours daily',
    DistanceUnit: 0,
  },
  Connections: [
    {
      ID: 1,
      ConnectionTypeID: 2,
      ConnectionType: { ID: 2, Title: 'CHAdeMO' },
      PowerKW: 100,
      Quantity: 4,
    },
  ],
} satisfies RawPoi;

/**
 * A London search row (station 67840, captured 2026-11-19) carrying the station-level fields every
 * search row can hold — `AddressLine2`, `UsageTypeID`, `UsageCost` — on an operator that publishes
 * a phone, website, and fault-report address.
 */
export const LONDON_POI = {
  ID: 67840,
  UUID: '487958B0-434E-424B-ADE1-94441CDA8448',
  DateCreated: '2016-06-03T13:14:00Z',
  UsageTypeID: 6,
  UsageCost: 'Free',
  OperatorID: 3,
  DataProviderID: 1,
  StatusTypeID: 0,
  UsageType: {
    ID: 6,
    Title: 'Private - For Staff, Visitors or Customers',
    IsPayAtLocation: false,
    IsMembershipRequired: false,
    IsAccessKeyRequired: false,
  },
  StatusType: { ID: 0, Title: 'Unknown' },
  OperatorInfo: {
    ID: 3,
    Title: 'POD Point (UK)',
    WebsiteURL: 'http://www.pod-point.com/',
    PhonePrimaryContact: '020 7247 4114',
    FaultReportEmail: 'enquiries@pod-point.com',
    IsPrivateIndividual: false,
  },
  DataProvider: {
    ID: 1,
    Title: 'Open Charge Map Contributors',
    License: 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)',
    IsOpenDataLicensed: true,
  },
  AddressInfo: {
    ID: 68186,
    Title: 'Trenchard House',
    AddressLine1: '19-25 Broadwick Street',
    AddressLine2: 'Soho',
    Town: 'London',
    Postcode: 'W1F 0DF',
    Latitude: 51.513535,
    Longitude: -0.135519,
    Distance: 0.8664466405613088,
    DistanceUnit: 1,
  },
  Connections: [
    {
      ID: 94400,
      ConnectionTypeID: 25,
      ConnectionType: { ID: 25, Title: 'Type 2 (Socket Only)' },
      PowerKW: 7,
      Quantity: 1,
    },
  ],
} satisfies RawPoi;

/**
 * Station 496719 (captured 2026-11-19) under operator 44, "(Private Residence/Individual)" — the
 * one operator OCM flags `IsPrivateIndividual`. Its site record still carries both phones (the
 * second holds an email address) and a related URL.
 */
export const PRIVATE_POI_DETAIL = {
  ID: 496719,
  UUID: 'PRIV0000-0000-0000-0000-000000496719',
  DateCreated: '2026-03-02T17:21:00Z',
  OperatorID: 44,
  UsageTypeID: 5,
  UsageCost: '$.30 per KWh, plus $5 per hour idle fee',
  StatusTypeID: 50,
  DataProviderID: 1,
  OperatorInfo: { ID: 44, Title: '(Private Residence/Individual)', IsPrivateIndividual: true },
  UsageType: { ID: 5, Title: 'Public - Pay At Location', IsPayAtLocation: true },
  StatusType: { ID: 50, Title: 'Operational', IsOperational: true },
  DataProvider: {
    ID: 1,
    Title: 'Open Charge Map Contributors',
    License: 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)',
    IsOpenDataLicensed: true,
  },
  AddressInfo: {
    ID: 496000,
    Title: 'Hyatt Place Charlotte / University Research Park',
    Latitude: 35.31,
    Longitude: -80.75,
    ContactTelephone1: '9802565500',
    ContactTelephone2: 'hyattplace.charlotte@dalyseven.com',
    RelatedURL:
      'https://www.hyatt.com/en-US/hotel/north-carolina/hyatt-place-charlotte-university-research-park/cltzv',
  },
  Connections: [{ ID: 1, ConnectionTypeID: 1, ConnectionType: { ID: 1, Title: 'Type 1 (J1772)' } }],
} satisfies RawPoi;

/** Seattle → Olympia → Longview → Portland, the waypoints of the route-search issue (#37). */
export const SEATTLE_PORTLAND_ROUTE = [
  { latitude: 47.6062, longitude: -122.3321 },
  { latitude: 47.0379, longitude: -122.9007 },
  { latitude: 46.1382, longitude: -122.9382 },
  { latitude: 45.5152, longitude: -122.6784 },
];

/**
 * A polyline search row: {@link FULL_POI} moved to a point, with no `Distance` and `DistanceUnit` 0,
 * the way Open Charge Map returns route matches.
 */
export function routePoi(id: number, latitude: number, longitude: number): RawPoi {
  return {
    ...FULL_POI,
    ID: id,
    AddressInfo: {
      ...FULL_POI.AddressInfo,
      Latitude: latitude,
      Longitude: longitude,
      Distance: null,
      DistanceUnit: 0,
    },
  };
}

/**
 * Real stations near {@link SEATTLE_PORTLAND_ROUTE}, captured 2026-11-19 from a polyline search,
 * newest first as Open Charge Map returns them. `off` is each station's distance from the route in
 * km, measured with a local equirectangular projection — a different method from the server's
 * spherical one, so the two agree to within a few tens of metres.
 */
export const SEATTLE_PORTLAND_ROWS = [
  { id: 380340, latitude: 47.62066, longitude: -122.32952, off: 1.62 }, // north of the start
  { id: 380023, latitude: 47.597218, longitude: -122.330446, off: 0.66 },
  { id: 379328, latitude: 47.08294, longitude: -122.781669, off: 4.62 },
  { id: 379255, latitude: 47.031233, longitude: -122.932594, off: 2.41 }, // Olympia
  { id: 376026, latitude: 45.54756, longitude: -122.66783, off: 1.79 },
  { id: 283524, latitude: 47.64994, longitude: -122.37907, off: 6.01 }, // outside 5 km
  { id: 249426, latitude: 46.679772, longitude: -122.976998, off: 4.69 },
  { id: 233702, latitude: 47.527372, longitude: -122.315385, off: 5.96 }, // outside 5 km
  { id: 233151, latitude: 46.003983, longitude: -122.845311, off: 2.74 },
  { id: 160371, latitude: 45.470578, longitude: -122.691695, off: 5.07 }, // past Portland, outside 5 km
  { id: 6628, latitude: 45.51211, longitude: -122.68317, off: 0.51 }, // Portland
];

/** Every `content[]` text block of a contract result, joined. */
export function contentText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** Build a minimal fake `Response` whose `.json()` resolves to `body`. */
export function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
