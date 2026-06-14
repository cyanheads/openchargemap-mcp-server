#!/usr/bin/env node
/**
 * @fileoverview openchargemap-mcp-server MCP server entry point. Find-and-detail server over the
 * global Open Charge Map registry: find stations, get full detail, resolve reference IDs, and read
 * community reliability check-ins.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { stationResource } from './mcp-server/resources/definitions/station.resource.js';
import { findStations } from './mcp-server/tools/definitions/find-stations.tool.js';
import { getStation } from './mcp-server/tools/definitions/get-station.tool.js';
import { getStationComments } from './mcp-server/tools/definitions/get-station-comments.tool.js';
import { lookupReference } from './mcp-server/tools/definitions/lookup-reference.tool.js';
import { initOpenChargeMapService } from './services/openchargemap/openchargemap-service.js';
import { initReferenceDataService } from './services/reference-data/reference-data-service.js';

await createApp({
  name: 'openchargemap-mcp-server',
  title: 'openchargemap-mcp-server',
  websiteUrl: 'https://github.com/cyanheads/openchargemap-mcp-server',
  tools: [findStations, getStation, lookupReference, getStationComments],
  resources: [stationResource],
  instructions:
    'Global EV charging station search over Open Charge Map. Coordinate-native — geocode place ' +
    'names with the openstreetmap server first, then pass coordinates here. Resolve connector/' +
    'network names to filter IDs with openchargemap_lookup_reference. Registry status is operator-' +
    'reported and can be stale — corroborate with dateLastVerified and openchargemap_get_station_comments. ' +
    'All station data is © Open Charge Map contributors, licensed under CC BY 4.0 (openchargemap.org); ' +
    'attribution is required in any downstream use.',
  async setup() {
    const serverConfig = getServerConfig();
    await initReferenceDataService(serverConfig);
    initOpenChargeMapService(serverConfig);
  },
});
