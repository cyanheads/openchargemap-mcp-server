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

  // Tool inputs are strict at the root, so a key the schema does not declare is rejected by name
  // rather than stripped. The near-miss casing below is the case that matters: it used to run the
  // search with the default unit and report nothing about the argument it dropped.
  it('rejects an undeclared root key by name instead of stripping it', () => {
    const result = findStations.input.safeParse({
      latitude: 47.6062,
      longitude: -122.3321,
      distanceunit: 'Miles',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['distanceunit'] }),
    );
  });

  // A nested object still strips, so a handler reading only declared inner fields is unaffected.
  it('still accepts an undeclared key nested inside boundingbox', () => {
    expect(
      findStations.input.safeParse({
        boundingbox: { sw_lat: 47.5, sw_lng: -122.5, ne_lat: 47.7, ne_lng: -122.2, zoom: 12 },
      }).success,
    ).toBe(true);
  });

  // https://github.com/cyanheads/openchargemap-mcp-server/issues/12
  // The service re-tags both 401 and 403 as auth_failed, so every tool that can hit the OCM HTTP
  // boundary must say so — the same stale string previously lived in all three files.
  it.each([findStations, getStation, getStationComments])(
    'documents both HTTP 401 and 403 in $name auth_failed contract',
    (definition) => {
      const auth = definition.errors?.find((entry) => entry.reason === 'auth_failed');
      expect(auth?.when).toContain('401');
      expect(auth?.when).toContain('403');
    },
  );

  it('exposes the station resource with numeric-id params and a handler', () => {
    expect(stationResource.name).toBe('openchargemap-station');
    // `params` is optional on the definition type — a resource may take none — so assert it is
    // declared before reading it, or a dropped schema would surface as a confusing parse failure.
    expect(stationResource.params).toBeDefined();
    expect(stationResource.params?.safeParse({ id: '145452' }).success).toBe(true);
    expect(stationResource.params?.safeParse({ id: 'not-a-number' }).success).toBe(false);
    expect(stationResource.handler).toBeTypeOf('function');
  });
});
