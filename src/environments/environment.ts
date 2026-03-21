export const environment = {
  production: false,
  /**
   * `/api/streams` — dev: proxied to LucentApi (`proxy.conf.json`); prod: same path on lucent.earth.
   * `production` flag comes from `environment.production.ts` in prod builds.
   */
  streamsUrl: '/api/streams',
};
