export const environment = {
  production: false,
  /**
   * `/api/streams` — dev: proxied to LucentApi (`proxy.conf.json`); prod: same path on lucent.earth.
   * `production` flag comes from `environment.production.ts` in prod builds.
   */
  streamsUrl: '/api/streams',
  /** Dev: `proxy.conf.json` forwards to de1.api.radio-browser.info. */
  radioBrowserBaseUrl: '/radio-browser',
  /**
   * Max geo-located stations for globe markers (Radio Browser search `limit`).
   * Mirror: `Lucent:RadioStationSearchLimit` in LucentApi `appsettings.json` (API does not call Radio Browser).
   */
  radioStationSearchLimit: 500,
  /**
   * When the station’s `<audio>` exposes `seekable` ranges (time-shifted / buffered web radio),
   * don’t allow seeking further back than this many seconds behind the range end (≈ live edge).
   * Set to `0` to disable. Does not cap browser RAM — only UI seek position when the API allows seek.
   */
  radioPlaybackMaxSeekBackSeconds: 60,
};
