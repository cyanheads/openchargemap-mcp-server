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
  Country?: RawCountry | null;
  CountryID?: number | null;
  Distance?: number | null;
  /** Integer enum: 1 = KM, 2 = Miles. Absent for bounding-box searches. */
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
  ID?: number;
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
  IsOperational?: boolean;
  Title?: string | null;
}

/** Raw OCM data-provider object. */
export interface RawDataProvider {
  ID?: number;
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
  level?: string;
  levelId?: number;
  powerKW?: number | null;
  quantity?: number | null;
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
  dateLastVerified?: string | null;
  distance?: number;
  distanceUnit?: 'KM' | 'Miles';
  id: number;
  isAccessKeyRequired?: boolean;
  isMembershipRequired?: boolean;
  isOperational?: boolean;
  isPayAtLocation?: boolean;
  isRecentlyVerified?: boolean;
  numberOfPoints?: number;
  operator?: string;
  operatorId?: number;
  status?: string;
  statusTypeId?: number;
  title: string;
  usageType?: string;
  uuid: string;
}

/** Detail-only fields layered on top of {@link NormalizedStation} by `get_station`. */
export interface NormalizedStationDetail extends NormalizedStation {
  comments?: NormalizedComment[];
  dataProviderUrl?: string;
  dateLastStatusUpdate?: string | null;
  generalComments?: string;
  media?: { url: string; comment?: string }[];
  submissionStatus?: string;
  usageCost?: string;
}

/**
 * Parameters accepted by `OpenChargeMapService.searchPois`. Location fields are mode-dependent
 * (radius vs bbox) — the caller supplies exactly one mode and the service guards each before
 * serializing, so they tolerate `undefined`.
 */
export interface SearchPoiParams {
  boundingbox?: { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number } | undefined;
  connectiontypeid?: number | number[];
  countrycode?: string;
  distance?: number | undefined;
  distanceUnit?: 'KM' | 'Miles' | undefined;
  latitude?: number | undefined;
  levelid?: number | number[];
  longitude?: number | undefined;
  maxresults: number;
  minchargepoints?: number;
  minpowerkw?: number;
  operatorid?: number | number[];
  statustypeid?: number | number[];
  usagetypeid?: number | number[];
}
