/**
 * @fileoverview Shared OCM POI fixtures for tool tests — a full station, a sparse station (omitted
 * upstream fields, absent StatusType key), and a station with comments.
 * @module tests/fixtures/ocm
 */

import type { RawPoi } from '@/services/openchargemap/types.js';

/** A fully-populated station (Seattle, ChargePoint, Temporarily Unavailable but IsOperational:true). */
export const FULL_POI: RawPoi = {
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
};

/** Detail-only fields layered on FULL_POI for verbose=true responses. */
export const FULL_POI_DETAIL: RawPoi = {
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
      UserName: 'evdriver1',
      Comment: 'Worked fine, two stalls open.',
      Rating: 5,
      DateCreated: '2025-05-01T10:00:00Z',
    },
    {
      ID: 2,
      CommentType: { ID: 30, Title: 'Fault Report' },
      UserName: 'evdriver2',
      Comment: 'Connector 1 would not start a session.',
      Rating: 2,
      DateCreated: '2025-06-01T10:00:00Z',
    },
  ],
};

/**
 * A sparse station — omits NumberOfPoints/UsageCost/GeneralComments, has NO StatusType key at all
 * (verified to happen on real records), null connection power, no operator.
 */
export const SPARSE_POI: RawPoi = {
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
};

/** Build a minimal fake `Response` whose `.json()` resolves to `body`. */
export function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
