import { environment } from './environments/environment';

/**
 * Loads gtag.js and configures GA4 when `environment.googleAnalyticsMeasurementId` is set.
 * Production: Lucent / https://lucent.earth — Measurement ID G-CJJXL1TLPM (Stream ID 14352370694).
 */
export function initGoogleAnalytics(): void {
  const id = environment.googleAnalyticsMeasurementId;
  if (!id || typeof document === 'undefined') return;

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);

  type GtagWindow = Window & { dataLayer: unknown[]; gtag: (...args: unknown[]) => void };
  const w = window as unknown as GtagWindow;
  w.dataLayer = w.dataLayer || [];
  w.gtag = function gtag(...args: unknown[]): void {
    w.dataLayer.push(args);
  };

  w.gtag('js', new Date());
  w.gtag('config', id);
}
