/**
 * @fileoverview Offline smoke checks for the registered Open Charge Map MCP definitions.
 * @module tests/smoke/definitions.smoke.test
 */

import { describe, expect, it } from 'vitest';
import { stationResource } from '@/mcp-server/resources/definitions/station.resource.js';
import { findStations } from '@/mcp-server/tools/definitions/find-stations.tool.js';
import { getStation } from '@/mcp-server/tools/definitions/get-station.tool.js';
import { getStationComments } from '@/mcp-server/tools/definitions/get-station-comments.tool.js';
import { lookupReference } from '@/mcp-server/tools/definitions/lookup-reference.tool.js';

describe('definition smoke checks', () => {
  it('exposes the four expected tool names', () => {
    expect(
      [findStations, getStation, getStationComments, lookupReference].map(
        (definition) => definition.name,
      ),
    ).toEqual([
      'openchargemap_find_stations',
      'openchargemap_get_station',
      'openchargemap_get_station_comments',
      'openchargemap_lookup_reference',
    ]);
  });

  it('gives every tool a callable handler and text formatter', () => {
    for (const definition of [findStations, getStation, getStationComments, lookupReference]) {
      expect(definition.handler).toBeTypeOf('function');
      expect(definition.format).toBeTypeOf('function');
      expect(definition.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('accepts one minimal valid input for every tool without making a network call', () => {
    expect(findStations.input.safeParse({ latitude: 47.6062, longitude: -122.3321 }).success).toBe(
      true,
    );
    expect(getStation.input.safeParse({ id: 145452 }).success).toBe(true);
    expect(getStationComments.input.safeParse({ id: 145452 }).success).toBe(true);
    expect(
      lookupReference.input.safeParse({ category: 'operators', query: 'ChargePoint' }).success,
    ).toBe(true);
  });

  it('exposes the station resource with numeric-id params and a handler', () => {
    expect(stationResource.name).toBe('openchargemap-station');
    expect(stationResource.params.safeParse({ id: '145452' }).success).toBe(true);
    expect(stationResource.params.safeParse({ id: 'not-a-number' }).success).toBe(false);
    expect(stationResource.handler).toBeTypeOf('function');
  });
});
