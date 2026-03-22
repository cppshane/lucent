export const environment = {
  production: true,
  /** Same origin as the SPA on https://lucent.earth */
  streamsUrl: '/api/streams',
  /**
   * Public Radio Browser node. If CORS blocks in your deployment, proxy this path on the same
   * origin (same pattern as dev `proxy.conf.json`).
   */
  radioBrowserBaseUrl: 'https://de1.api.radio-browser.info',
  /** Keep in sync with `Lucent:RadioStationSearchLimit` in LucentApi appsettings (documentary). */
  radioStationSearchLimit: 5000,
  radioPlaybackMaxSeekBackSeconds: 60,
};
