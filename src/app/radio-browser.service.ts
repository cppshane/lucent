import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, concat, map, of, reduce } from 'rxjs';
import { environment } from '../environments/environment';
import { pickRadioUrlPayload, toGlobeRadioPoint, type GlobeRadioPoint } from './radio.models';

/** Descriptive client id for Radio Browser (they request a speaking User-Agent). */
export const RADIO_BROWSER_USER_AGENT = 'LucentEarth/1.0';

/** Radio Browser clamps each `/json/stations/search` response; use `?offset=` on the URL to page past it. */
export const RADIO_BROWSER_MAX_STATIONS_PER_REQUEST = 1000;

@Injectable({ providedIn: 'root' })
export class RadioBrowserService {
  private readonly http = inject(HttpClient);

  private headers(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'User-Agent': RADIO_BROWSER_USER_AGENT,
    });
  }

  private searchBodyForPage(pageLimit: number): object[] {
    return [
      { name: 'has_geo_info', value: true },
      { name: 'hidebroken', value: true },
      { name: 'limit', value: pageLimit },
      { name: 'order', value: 'votes' },
      { name: 'reverse', value: true },
    ];
  }

  private mapSearchPayload(payload: unknown): GlobeRadioPoint[] {
    if (!Array.isArray(payload)) return [];
    return payload
      .map((r) => toGlobeRadioPoint(r))
      .filter((p): p is GlobeRadioPoint => p !== null);
  }

  /**
   * Geo-located stations (votes-desc). Calls Radio Browser directly from the browser
   * (dev: `proxy.conf.json` → de1). No LucentApi hop — target count is
   * `environment.radioStationSearchLimit`. The API returns at most
   * {@link RADIO_BROWSER_MAX_STATIONS_PER_REQUEST} per call; larger totals use sequential
   * `?offset=` pages (offset in the JSON body is not applied reliably for POST).
   */
  searchStationsWithGeo(): Observable<GlobeRadioPoint[]> {
    const desired = Math.max(0, Math.floor(environment.radioStationSearchLimit));
    if (desired === 0) return of([]);

    const base = `${environment.radioBrowserBaseUrl}/json/stations/search`;
    const cap = RADIO_BROWSER_MAX_STATIONS_PER_REQUEST;
    const hdr = this.headers();

    const pageRequests: Observable<GlobeRadioPoint[]>[] = [];
    for (let skip = 0; skip < desired; skip += cap) {
      const pageLimit = Math.min(cap, desired - skip);
      const url = `${base}?offset=${skip}`;
      pageRequests.push(
        this.http.post<unknown>(url, this.searchBodyForPage(pageLimit), { headers: hdr }).pipe(
          map((payload) => this.mapSearchPayload(payload)),
          catchError((err) => {
            console.error('Radio Browser search failed:', err);
            return of([] as GlobeRadioPoint[]);
          }),
        ),
      );
    }

    if (pageRequests.length === 1) {
      return pageRequests[0]!.pipe(map((list) => list.slice(0, desired)));
    }

    return concat(...pageRequests).pipe(
      reduce((acc, page) => {
        for (const p of page) {
          if (!acc.seen.has(p.stationuuid)) {
            acc.seen.add(p.stationuuid);
            acc.list.push(p);
          }
        }
        return acc;
      }, { list: [] as GlobeRadioPoint[], seen: new Set<string>() }),
      map(({ list }) => list.slice(0, desired)),
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
