export const environment = {
  production: true,
  /**
   * GA4 web stream: Lucent — https://lucent.earth (Stream ID 14352370694).
   */
  googleAnalyticsMeasurementId: 'G-CJJXL1TLPM',
  /** Same origin as the SPA on https://lucent.earth */
  streamsUrl: '/api/streams',
  /**
   * Public Radio Browser node. If CORS blocks in your deployment, proxy this path on the same
   * origin (same pattern as dev `proxy.conf.json`).
   */
  radioBrowserBaseUrl: 'https://de1.api.radio-browser.info',
  /** Target station count for the globe; >1000 uses paged Radio Browser requests. See appsettings `RadioStationSearchLimit` if you keep them aligned. */
  radioStationSearchLimit: 5000,
  radioPlaybackMaxSeekBackSeconds: 60,
};
