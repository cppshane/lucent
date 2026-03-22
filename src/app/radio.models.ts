/**
 * Fields we read from each `/json/stations/search` row. The API returns many more
 * properties; we never retain them on `GlobeRadioPoint` (smaller heap). The HTTP
 * response body is still full JSON — there is no field-projection on their API.
 */
export interface RadioSearchRowPicked {
  stationuuid: string;
  name?: string;
  geo_lat?: number;
  geo_long?: number;
  homepage?: string;
  country?: string;
  countrycode?: string;
}

export function pickRadioSearchRow(row: unknown): RadioSearchRowPicked | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as Record<string, unknown>;
  const stationuuid = o['stationuuid'];
  if (typeof stationuuid !== 'string' || !stationuuid) return null;
  const geo_lat = o['geo_lat'];
  const geo_long = o['geo_long'];
  return {
    stationuuid,
    name: typeof o['name'] === 'string' ? o['name'] : undefined,
    geo_lat: typeof geo_lat === 'number' ? geo_lat : undefined,
    geo_long: typeof geo_long === 'number' ? geo_long : undefined,
    homepage: typeof o['homepage'] === 'string' ? o['homepage'] : undefined,
    country: typeof o['country'] === 'string' ? o['country'] : undefined,
    countrycode: typeof o['countrycode'] === 'string' ? o['countrycode'] : undefined,
  };
}

export function pickRadioUrlPayload(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (o['ok'] !== true) return null;
  const url = o['url'];
  return typeof url === 'string' ? url : null;
}

export interface GlobeRadioPoint {
  kind: 'radio';
  markerId: string;
  stationuuid: string;
  latitude: number;
  longitude: number;
  name: string;
  homepage: string;
  country: string;
  countrycode: string;
}

export interface GlobeRadioSelection {
  station: GlobeRadioPoint;
  playUrl: string | null;
}

export function radioMarkerId(stationuuid: string): string {
  return `radio-${stationuuid}`;
}

export function toGlobeRadioPoint(row: unknown): GlobeRadioPoint | null {
  const d = pickRadioSearchRow(row);
  if (!d) return null;
  const lat = d.geo_lat;
  const lng = d.geo_long;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const rawName = (d.name ?? '').replace(/^\s+/, '').trim();
  return {
    kind: 'radio',
    markerId: radioMarkerId(d.stationuuid),
    stationuuid: d.stationuuid,
    latitude: lat as number,
    longitude: lng as number,
    name: rawName || 'Unknown station',
    homepage: d.homepage ?? '',
    country: d.country ?? '',
    countrycode: d.countrycode ?? '',
  };
}
