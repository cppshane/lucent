import type { GlobeRadioPoint } from './radio.models';
import type { GlobeStreamPoint } from './stream.models';

export type GlobeMapPoint = GlobeStreamPoint | GlobeRadioPoint;

export function isGlobeRadioPoint(p: GlobeMapPoint): p is GlobeRadioPoint {
  return p.kind === 'radio';
}

export function isGlobeStreamMapPoint(p: GlobeMapPoint): p is GlobeStreamPoint {
  return p.kind === 'stream';
}

export function mapPointMarkerId(p: GlobeMapPoint): string {
  return isGlobeRadioPoint(p) ? p.markerId : p.channelLogin;
}
