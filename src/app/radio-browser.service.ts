import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { environment } from '../environments/environment';
import { pickRadioUrlPayload, toGlobeRadioPoint, type GlobeRadioPoint } from './radio.models';

/** Descriptive client id for Radio Browser (they request a speaking User-Agent). */
export const RADIO_BROWSER_USER_AGENT = 'LucentEarth/1.0';

@Injectable({ providedIn: 'root' })
export class RadioBrowserService {
  private readonly http = inject(HttpClient);

  private headers(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'User-Agent': RADIO_BROWSER_USER_AGENT,
    });
  }

  /**
   * Geo-located stations (votes-desc). Calls Radio Browser directly from the browser
   * (dev: `proxy.conf.json` → de1). No LucentApi hop — limit is `environment.radioStationSearchLimit`.
   */
  searchStationsWithGeo(): Observable<GlobeRadioPoint[]> {
    const limit = environment.radioStationSearchLimit;
    const body = [
      { name: 'has_geo_info', value: true },
      { name: 'hidebroken', value: true },
      { name: 'limit', value: limit },
      { name: 'order', value: 'votes' },
      { name: 'reverse', value: true },
    ];
    return this.http
      .post<unknown>(
        `${environment.radioBrowserBaseUrl}/json/stations/search`,
        body,
        { headers: this.headers() },
      )
      .pipe(
        map((payload) => {
          if (!Array.isArray(payload)) return [] as GlobeRadioPoint[];
          return payload
            .map((r) => toGlobeRadioPoint(r))
            .filter((p): p is GlobeRadioPoint => p !== null);
        }),
        catchError((err) => {
          console.error('Radio Browser search failed:', err);
          return of([] as GlobeRadioPoint[]);
        }),
      );
  }

  /** Call when the user selects a station (popularity / click tracking). */
  notifyStationClick(stationuuid: string): Observable<string | null> {
    const url = `${environment.radioBrowserBaseUrl}/json/url/${encodeURIComponent(stationuuid)}`;
    return this.http.post<unknown>(url, {}, { headers: this.headers() }).pipe(
      map((body) => pickRadioUrlPayload(body)),
      catchError((err) => {
        console.error('Radio Browser url notify failed:', err);
        return of(null);
      }),
    );
  }
}
