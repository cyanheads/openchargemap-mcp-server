/**
 * @fileoverview Domain types for the Open Charge Map service — raw upstream POI shapes (modeled
 * permissively for OCM's heavy sparsity) and the normalized station shape the tools surface.
 * @module services/openchargemap/types
 */

/* ------------------------------------------------------------------ *
 * Raw upstream shapes (OCM /v3/poi). Every field optional/nullable —  *
 * OCM omits keys entirely and nullifies values freely.               *
 * ------------------------------------------------------------------ */

/** Raw OCM nested reference object (ConnectionType, Level, CurrentType, etc.). */
export interface RawReference {
  FormalName?: string | null;
  ID?: number;
  Title?: string | null;
}

/** Raw OCM connection record. */
export interface RawConnection {
  Amps?: number | null;
  Comments?: string | null;
  ConnectionType?: RawReference | null;
  ConnectionTypeID?: number | null;
  CurrentType?: { ID?: number; Title?: string | null } | null;
  CurrentTypeID?: number | null;
  ID?: number;
  Level?: { ID?: number; Title?: string | null } | null;
  LevelID?: number | null;
  PowerKW?: number | null;
  Quantity?: number | null;
  StatusType?: RawStatusType | null;
  StatusTypeID?: number | null;
  Voltage?: number | null;
}

/** Raw OCM nested country object. */
export interface RawCountry {
  ContinentCode?: string | null;
  ISOCode?: string | null;
  Title?: string | null;
}

/** Raw OCM AddressInfo object. */
export interface RawAddressInfo {
  AccessComments?: string | null;
  AddressLine1?: string | null;
  AddressLine2?: string | null;
  ContactTelephone1?: string | null;
  ContactTelephone2?: string | null;
  Country?: RawCountry | null;
  CountryID?: number | null;
  Distance?: number | null;
  /** Integer enum: 1 = KM, 2 = Miles. Absent, like `Distance`, on polyline (route) searches. */
  DistanceUnit?: number | null;
  ID?: number;
  Latitude?: number;
  Longitude?: number;
  Postcode?: string | null;
  RelatedURL?: string | null;
  StateOrProvince?: string | null;
  Title?: string | null;
  Town?: string | null;
}

/** Raw OCM operator object. */
export interface RawOperatorInfo {
  FaultReportEmail?: string | null;
  ID?: number;
  /**
   * True for an operator that is a home owner or private individual. OCM sets it on one operator,
   * 44 "(Private Residence/Individual)"; it gates every phone, URL, and email the detail returns.
   */
  IsPrivateIndividual?: boolean | null;
  PhonePrimaryContact?: string | null;
  Title?: string | null;
  WebsiteURL?: string | null;
}

/** Raw OCM usage-type object. */
export interface RawUsageType {
  ID?: number;
  IsAccessKeyRequired?: boolean | null;
  IsMembershipRequired?: boolean | null;
  IsPayAtLocation?: boolean | null;
  Title?: string | null;
}

/**
 * Raw OCM status-type object. `IsOperational` is ABSENT (not null) for Unknown (ID 0); the entire
 * `StatusType` key can also be missing from a POI record — guard before reading.
 */
export interface RawStatusType {
  ID?: number;
  IsOperational?: boolean | null;
  Title?: string | null;
}

/** Raw OCM data-provider object. */
export interface RawDataProvider {
  ID?: number;
  IsOpenDataLicensed?: boolean | null;
  License?: string | null;
  Title?: string | null;
  WebsiteURL?: string | null;
}

/** Raw OCM submission-status object. */
export interface RawSubmissionStatus {
  ID?: number;
  Title?: string | null;
}

/** Raw OCM media item. */
export interface RawMediaItem {
  Comment?: string | null;
  ItemURL?: string | null;
}

/**
 * Raw OCM check-in outcome attached to a user comment — an 18-entry controlled vocabulary.
 * `IsPositive` is OCM's own classification of the outcome; it is null for "Did Not Visit Location".
 */
export interface RawCheckinStatusType {
  ID?: number;
  IsPositive?: boolean | null;
  Title?: string | null;
}

/** Raw OCM user comment. */
export interface RawUserComment {
  CheckinStatusType?: RawCheckinStatusType | null;
  CheckinStatusTypeID?: number | null;
  Comment?: string | null;
  CommentType?: { ID?: number; Title?: string | null } | null;
  CommentTypeID?: number | null;
  DateCreated?: string | null;
  ID?: number;
  Rating?: number | null;
  RelatedURL?: string | null;
  UserName?: string | null;
}

/** Raw OCM POI (station) record. */
export interface RawPoi {
  AddressInfo?: RawAddressInfo | null;
  Connections?: RawConnection[] | null;
  DataProvider?: RawDataProvider | null;
  DataProviderID?: number | null;
  DateCreated?: string | null;
  DateLastStatusUpdate?: string | null;
  DateLastVerified?: string | null;
  GeneralComments?: string | null;
  ID?: number;
  IsRecentlyVerified?: boolean | null;
  MediaItems?: RawMediaItem[] | null;
  NumberOfPoints?: number | null;
  OperatorID?: number | null;
  OperatorInfo?: RawOperatorInfo | null;
  StatusType?: RawStatusType | null;
  StatusTypeID?: number | null;
  SubmissionStatus?: RawSubmissionStatus | null;
  UsageCost?: string | null;
  UsageType?: RawUsageType | null;
  UsageTypeID?: number | null;
  UserComments?: RawUserComment[] | null;
  UUID?: string;
}

/* ------------------------------------------------------------------ *
 * Normalized shapes (what the tools surface).                        *
 * ------------------------------------------------------------------ */

/** Normalized address — absent fields preserved as absent (unknown). */
export interface NormalizedAddress {
  accessComments?: string;
  country?: string;
  countryCode?: string;
  latitude: number;
  line1?: string;
  line2?: string;
  longitude: number;
  postcode?: string;
  stateOrProvince?: string;
  town?: string;
}

/** Normalized connection. */
export interface NormalizedConnection {
  amps?: number | null;
  connectionType?: string;
  connectionTypeId?: number;
  currentType?: string;
  isOperational?: boolean;
  level?: string;
  levelId?: number;
  notes?: string;
  powerKW?: number | null;
  quantity?: number | null;
  status?: string;
  statusTypeId?: number;
  voltage?: number | null;
}

/**
 * Normalized community comment. `checkinStatusIsPositive` carries OCM's own classification of the
 * outcome. It reaches the tool schemas as well as the reliability layer, because the titles do not
 * all read the way OCM scores them — "Charging Spot In Use (Other EV Parked)" is positive,
 * "Charging Spot In Use (Non-EV Parked)" is not — and no tool publishes the check-in vocabulary a
 * client could look the polarity up in.
 */
export interface NormalizedComment {
  checkinStatus?: string;
  checkinStatusId?: number;
  checkinStatusIsPositive?: boolean;
  comment?: string;
  commentType?: string;
  dateCreated?: string;
  rating?: number | null;
  relatedUrl?: string;
  user?: string;
}

/** Normalized station — the shape `find_stations` returns and `get_station` extends. */
export interface NormalizedStation {
  address: NormalizedAddress;
  connections: NormalizedConnection[];
  dataProvider?: string;
  dataProviderId?: number;
  dataProviderLicense?: string;
  dateLastVerified?: string | null;
  distance?: number;
  distanceUnit?: 'KM' | 'Miles';
  id: number;
  isAccessKeyRequired?: boolean;
  isMembershipRequired?: boolean;
  isOpenDataLicensed?: boolean;
  isOperational?: boolean;
  isPayAtLocation?: boolean;
  isRecentlyVerified?: boolean;
  numberOfPoints?: number;
  /** Route searches only: from the station to its nearest point on the route, in `distanceUnit`. */
  offRouteDistance?: number;
  operator?: string;
  operatorId?: number;
  /**
   * Route searches only: along the route from its first point to the station's nearest point on
   * it, in `distanceUnit`.
   */
  routeDistance?: number;
  status?: string;
  statusTypeId?: number;
  title: string;
  usageCost?: string;
  usageType?: string;
  usageTypeId?: number;
  uuid: string;
}

/**
 * Detail-only fields layered on top of {@link NormalizedStation} by `get_station`. The six contact
 * fields are omitted whenever the operator is a private individual.
 */
export interface NormalizedStationDetail extends NormalizedStation {
  comments?: NormalizedComment[];
  contactPhone?: string;
  contactPhoneSecondary?: string;
  dataProviderUrl?: string;
  dateCreated?: string;
  dateLastStatusUpdate?: string | null;
  generalComments?: string;
  media?: { url: string; comment?: string }[];
  operatorFaultReportEmail?: string;
  operatorPhone?: string;
  operatorWebsite?: string;
  relatedUrl?: string;
  submissionStatus?: string;
}

/* ------------------------------------------------------------------ *
 * Search parameters and results.                                     *
 * ------------------------------------------------------------------ */

/** The unit a search measures its radius and its stations' distances in. */
export type DistanceUnit = 'KM' | 'Miles';

/**
 * A latitude/longitude rectangle, edges included. The latitude corners may come in either order;
 * `sw_lng > ne_lng` reads as a box that crosses ±180°.
 */
export interface BoundingBox {
  ne_lat: number;
  ne_lng: number;
  sw_lat: number;
  sw_lng: number;
}

/** One point of a route, in WGS84 decimal degrees. */
export interface RoutePoint {
  latitude: number;
  longitude: number;
}

/** Where a search looks — one member per location mode. */
export type SearchLocation =
  | {
      mode: 'radius';
      latitude: number;
      longitude: number;
      distance: number;
      distanceUnit: DistanceUnit;
    }
  | { mode: 'box'; box: BoundingBox; distanceUnit: DistanceUnit }
  | {
      mode: 'route';
      /** The route's points in travel order, 2 or more. */
      route: RoutePoint[];
      /** Corridor half-width: how far from the route a station may sit. */
      distance: number;
      distanceUnit: DistanceUnit;
    };

/** Parameters accepted by `OpenChargeMapService.searchPois`: one location plus optional filters. */
export interface SearchPoiParams {
  connectiontypeid?: number | number[];
  countrycode?: string;
  levelid?: number | number[];
  location: SearchLocation;
  minchargepoints?: number;
  minpowerkw?: number;
  operatorid?: number | number[];
  statustypeid?: number | number[];
  usagetypeid?: number | number[];
}

/**
 * The search as the service ran it, in the search's unit. A radius search is its own circle; a box is
 * searched from its center out to its farthest point, and carries both; a route carries its corridor
 * half-width and its length.
 */
export type SearchArea =
  | {
      mode: 'radius';
      latitude: number;
      longitude: number;
      distance: number;
      distanceUnit: DistanceUnit;
    }
  | {
      mode: 'box';
      box: BoundingBox;
      /** True when the box spans ±180° longitude (`sw_lng > ne_lng`). */
      crossesAntimeridian: boolean;
      /** Distance from the box center to the farthest point of the box. */
      distance: number;
      distanceUnit: DistanceUnit;
      latitude: number;
      longitude: number;
    }
  | {
      mode: 'route';
      route: RoutePoint[];
      /** Corridor half-width. */
      distance: number;
      distanceUnit: DistanceUnit;
      /** Length of the route along its legs. */
      length: number;
    };

/**
 * What one `searchPois` call retrieved. The caller slices its own window out of `matches`; the
 * fetch counts are what let it tell a genuinely empty search area apart from a candidate page the
 * local filters emptied, and disclose that more may sit past what was retrieved.
 */
export interface SearchPoiResult {
  /** The search as it ran, including a box's center and farthest-point distance. */
  area: SearchArea;
  /** Records Open Charge Map requested for this candidate page. */
  candidateCap: number;
  /** Pool records before local filtering, excluding the sentinel. */
  fetched: number;
  /**
   * Stations that survived local filtering — the whole retrieved set, nearest first (in route
   * order along a route), with station `id` breaking ties.
   */
  matches: NormalizedStation[];
  /** Whether an additional raw record proved an upstream remainder beyond the candidate pool. */
  moreUpstream: boolean;
  /**
   * Distance of the farthest pool record from the search point, before local filters, in the
   * search's unit. Open Charge Map returns the nearest records first, so every station closer than
   * this is in the pool. Absent when no pool record carries a distance, as in a route search.
   */
  reach?: number;
}
