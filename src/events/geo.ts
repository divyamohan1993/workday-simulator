/**
 * Geo reference data and velocity math for AUTH events.
 *
 * WHY this module exists: two AUTH payloads carry geography that must be internally
 * consistent, `LoginSuccessPayload.geo` (where a login came from) and
 * `ImpossibleTravelPayload` (a geo-velocity anomaly). Impossible travel is only
 * believable when the implied speed is actually computed from the two coordinates and
 * the elapsed time, so this module owns the coordinates of the eight modeled sites,
 * a pool of far-flung "attacker" cities, and the haversine distance used to derive
 * `impliedSpeedKmh`. Everything here is pure and deterministic; randomness is the
 * caller's (the generator passes its seeded faker).
 */

import type { GeoPoint, LocationCode } from '../types/index.js';
import { LOCATIONS } from '../domain/index.js';

/** Approximate city-center coordinates for each modeled Deutsche Bank site. */
const SITE_COORDS: Record<LocationCode, { lat: number; lng: number }> = {
  FFT: { lat: 50.1109, lng: 8.6821 },
  LDN: { lat: 51.5074, lng: -0.1278 },
  NYC: { lat: 40.7128, lng: -74.006 },
  SIN: { lat: 1.3521, lng: 103.8198 },
  HKG: { lat: 22.3193, lng: 114.1694 },
  BLR: { lat: 12.9716, lng: 77.5946 },
  PNQ: { lat: 18.5204, lng: 73.8567 },
  JAX: { lat: 30.3322, lng: -81.6557 },
};

/**
 * Far-flung locations used as the suspicious endpoint of an impossible-travel event
 * and as card-transaction geographies. None coincide with a Deutsche Bank site, so a
 * hop to one from a normal work location always yields a large distance.
 */
export const REMOTE_GEOS: readonly GeoPoint[] = [
  { city: 'Moscow', country: 'RU', lat: 55.7558, lng: 37.6173 },
  { city: 'Lagos', country: 'NG', lat: 6.5244, lng: 3.3792 },
  { city: 'Sao Paulo', country: 'BR', lat: -23.5505, lng: -46.6333 },
  { city: 'Sydney', country: 'AU', lat: -33.8688, lng: 151.2093 },
  { city: 'Johannesburg', country: 'ZA', lat: -26.2041, lng: 28.0473 },
  { city: 'Kyiv', country: 'UA', lat: 50.4501, lng: 30.5234 },
  { city: 'Tehran', country: 'IR', lat: 35.6892, lng: 51.389 },
  { city: 'Bogota', country: 'CO', lat: 4.711, lng: -74.0721 },
  { city: 'Istanbul', country: 'TR', lat: 41.0082, lng: 28.9784 },
  { city: 'Jakarta', country: 'ID', lat: -6.2088, lng: 106.8456 },
];

/** Build the canonical GeoPoint for a modeled site. */
export function geoForLocation(code: LocationCode): GeoPoint {
  const site = LOCATIONS[code];
  const coords = SITE_COORDS[code];
  return { city: site.city, country: site.country, lat: coords.lat, lng: coords.lng };
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two geo points in kilometres (haversine). Used to
 * derive the implied speed of an impossible-travel event so the anomaly is real, not
 * three independently-random numbers.
 *
 * @param a First point.
 * @param b Second point.
 * @returns Distance in kilometres, rounded to whole km.
 */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(EARTH_RADIUS_KM * c);
}

/**
 * Implied travel speed in km/h for covering `km` in `minutes`. Guards a zero or
 * negative interval by treating it as a very short positive window, so the result is
 * always a finite, plausibly-superhuman number for a genuine anomaly.
 *
 * @param km Distance covered.
 * @param minutes Elapsed time between the two logins.
 * @returns Speed in km/h, rounded to whole units.
 */
export function impliedSpeedKmh(km: number, minutes: number): number {
  const hours = Math.max(minutes, 1) / 60;
  return Math.round(km / hours);
}
