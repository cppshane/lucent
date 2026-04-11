import { HttpClient } from '@angular/common/http';
import { catchError, firstValueFrom, of } from 'rxjs';
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostBinding,
  Input,
  NgZone,
  OnDestroy,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import Globe from 'globe.gl';
import type { GlobeInstance } from 'globe.gl';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { environment } from '../../environments/environment';
import {
  mapPointMarkerId,
  type GlobeMapPoint,
  isGlobeRadioPoint,
} from '../globe-map.models';
import { RadioBrowserService } from '../radio-browser.service';
import type { GlobeRadioPoint, GlobeRadioSelection } from '../radio.models';
import {
  type GlobeStreamPoint,
  type StreamDto,
  toGlobeStreamPoint,
} from '../stream.models';
import {
  createDayNightGlobeMaterial,
  sunSubSolarPoint,
} from './day-night-globe';

/** Minimal GeoJSON feature shape for Natural Earth admin dataset */
interface GeoFeature {
  properties: { ISO_A2?: string };
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

interface BorderPath {
  pnts: [number, number][];
  style: 'base' | 'glow1' | 'glow2';
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

/**
 * Preloaded globe visuals (textures + GeoJSON borders). Stream/radio markers load afterward
 * so the earth can appear without waiting on LucentApi or Radio Browser.
 */
interface GlobeAssetPreload {
  dayTex: THREE.Texture;
  nightTex: THREE.Texture;
  countryFeatures: GeoFeature[];
  borderPaths: BorderPath[];
  disposeTextures(): void;
}

@Component({
  selector: 'app-globe-view',
  standalone: true,
  template: `
    <div class="globe-shell">
      @if (globeLoading) {
        <div class="globe-loading" role="status" aria-live="polite">
          <div class="globe-loading-inner">
            <div class="globe-loading-spinner" aria-hidden="true"></div>
            <span class="globe-loading-label">Loading globe…</span>
          </div>
        </div>
      }
      <div #globeHost class="globe-host"></div>
    </div>
  `,
  styleUrl: './globe-view.component.css',
})
export class GlobeViewComponent implements AfterViewInit, OnDestroy, OnChanges {
  @ViewChild('globeHost', { static: true })
  globeHost!: ElementRef<HTMLElement>;

  @Output() streamSelected = new EventEmitter<GlobeStreamPoint>();
  @Output() radioSelected = new EventEmitter<GlobeRadioSelection>();
  /** Current stream catalogue (refreshed with `/api/streams`) for sidebar search. */
  @Output() streamsCatalogChange = new EventEmitter<GlobeStreamPoint[]>();

  @Input() sidebarOpen = false;
  /** While true, globe width follows inset immediately (sidebar drag resize). */
  @Input() @HostBinding('class.globe-inset-snap') sidebarInsetSnap = false;
  /** Corner mini-globe: fixed size, no zoom/rotate (Focus mode). */
  @Input() @HostBinding('class.globe-view--focus') focusMode = false;
  @Input() selectedStream: GlobeStreamPoint | null = null;
  /** Sidebar radio selection — used to fly the camera to the station. */
  @Input() selectedRadio: GlobeRadioSelection | null = null;
  /** First-load `?stream=` login; matched after streams HTTP returns */
  @Input() initialStreamQuery: string | null = null;
  /** First-load `?radio=` station UUID */
  @Input() initialRadioQuery: string | null = null;

  /** Shown until assets + WebGL layers are ready; intro clock starts on the next frames after hide. */
  globeLoading = true;

  private globe: GlobeInstance | null = null;
  private alive = false;

  private countryFeatures: GeoFeature[] | null = null;
  private borderPaths: BorderPath[] | null = null;

  /**
   * Closest zoom allowed (globe.gl POV `altitude`; smaller = closer). No tile map — this
   * replaces the old map-mode threshold as a hard stop for zoom and interaction.
   */
  private readonly minCameraAltitude = 0.006;
  /** Camera distance in globe radii; larger = more zoomed out */
  private readonly initialGlobeAltitude = 2.65;
  /** OrbitControls idle spin — default sidebar view. */
  private readonly orbitAutoRotateSpeedDefault = 0.04;
  /** Faster idle spin in Focus mini-globe (zoomed out — needs visible motion). */
  private readonly orbitAutoRotateSpeedFocus = 0.15;
  /** Animate back to `initialGlobe*` when entering Focus (matches first-visit framing). */
  private readonly focusModeInitialViewTransitionMs = 700;
  private readonly selectedFocusAltitude = 0.42;
  private readonly selectedFocusTransitionMs = 900;
  private readonly markerRadiusMax = 0.28;
  /** Angular radius (deg) at `minCameraAltitude`; keeps bars slim when fully zoomed in. */
  private readonly markerRadiusMin = 0.0022;
  private readonly markerHoverScale = 1.45;
  /** Invisible pick mesh radius/height vs visible bar (easier hover/click). */
  private markerHitTargetRadiusFactor = 2.85;
  private markerHitTargetHeightFactor = 1.12;
  private readonly markerHitTargetRadiusFactorFinePointer = 2.85;
  private readonly markerHitTargetHeightFactorFinePointer = 1.12;
  /** Larger on touch / hybrid devices — fat-finger targets without widening mouse-only overlap. */
  private readonly markerHitTargetRadiusFactorCoarsePointer = 5;
  private readonly markerHitTargetHeightFactorCoarsePointer = 1.5;
  private readonly streamMarkerVisibleName = 'streamMarkerVisible';
  private readonly streamMarkerHitName = 'streamMarkerHit';
  /** Cylinder length (`pointAltitude` × globe radius); hybrid linear / log (see viewerCountToPointAltitude) */
  private readonly markerAltitudeMin = 0.003;
  /**
   * Desired ceiling for bar `pointAltitude`; actual max is also capped by focus zoom so the
   * camera never sits inside the tallest cylinder (see `maxPointAltitudeForFocusZoom`).
   */
  private readonly markerAltitudeMax = 0.5;
  /** Gap (globe-relative, same units as POV `altitude`) between bar top and camera when focused */
  private readonly markerAltitudeFocusClearance = 0.045;
  /** Above this viewer count, bar height stays at `markerAltitudeMax` (log segment cap) */
  private readonly markerViewersAltitudeCap = 250_000;
  /** Linear cylinder scaling from 0 viewers through this count (inclusive). */
  private readonly markerAltitudeLinearViewerCeiling = 1000;
  /**
   * At `markerAltitudeLinearViewerCeiling` viewers, height has reached this fraction of
   * the full [min, max] band; everything above uses log₁₀ up to `markerViewersAltitudeCap`.
   */
  private readonly markerAltitudeLinearBandFraction = 0.78;
  /** Twitch purple — base pixels pass `globeBloomThreshold` with emissive. */
  private readonly streamMarkerColorTwitch = 'rgba(158, 95, 255, 1)';
  private readonly streamMarkerHoverColorTwitch = 'rgba(200, 160, 255, 0.99)';
  /** EarthCam YouTube — red glow. */
  private readonly streamMarkerColorYoutube = 'rgba(255, 72, 72, 1)';
  private readonly streamMarkerHoverColorYoutube = 'rgba(255, 150, 140, 0.99)';
  /** Kick — green glow (Gemini-geolocated IRL). */
  private readonly streamMarkerColorKick = 'rgba(64, 220, 130, 1)';
  private readonly streamMarkerHoverColorKick = 'rgba(150, 255, 200, 0.99)';
  /** Radio markers: short white cylinders, narrower than stream bars. */
  private readonly radioMarkerRadiusScale = 0.38;
  /** Globe-radius fraction for fixed radio cylinder height (streams scale with viewers). */
  private readonly radioPointAltitude = 0.0048;
  private readonly radioMarkerColor = 'rgba(248, 248, 252, 1)';
  private readonly radioMarkerHoverColor = 'rgba(255, 255, 255, 1)';
  private readonly radioMarkerEmissiveIntensity = 0.88;
  private readonly radioMarkerHoverEmissiveIntensity = 1.12;
  /**
   * three-globe uses MeshLambertMaterial for stream cylinders. Emissive brings luminance
   * over the bloom threshold; hover tint is already bright — use a lower intensity there.
   */
  private readonly streamMarkerEmissiveIntensity = 1.05;
  private readonly streamMarkerHoverEmissiveIntensity = 0.68;
  /** Initial focal point (Americas — Western Hemisphere) */
  private readonly initialGlobeLat = 28;
  private readonly initialGlobeLng = -92;
  private readonly rotateDelayMs = 1250;
  /** Matches globe.gl defaults when `animateIn` was true (scale 600ms, spin 1200ms). */
  private readonly introScaleDurationMs = 600;
  private readonly introRotationDurationMs = 1200;
  private introAnimationActive = false;
  private introAnimationStartTime = 0;
  private introScene: THREE.Scene | null = null;
  private readonly introRotAxis = new THREE.Vector3(0, 1, 0);

  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRotateEnabled = false;
  private hoveredMarkerId: string | null = null;

  private bloomConfigured = false;
  /** Bloom pass — disabled in Focus mode so EffectComposer preserves transparent clear (no dark ring). */
  private globeBloomPass: InstanceType<typeof UnrealBloomPass> | null = null;
  /**
   * UnrealBloom uses screen luminance. Day texture must peak *below* `globeBloomThreshold`
   * (after `globeDayTextureBloomCap`); Twitch purple + border lines sit a bit above after lighting.
   * If glow disappears, lower threshold slightly; if clouds bloom again, lower the day cap.
   */
  private readonly globeDayTextureBloomCap = 0.28;
  private readonly globeBloomStrength = 0.32;
  private readonly globeBloomRadius = 0.55;
  private readonly globeBloomThreshold = 0.34;
  /** globe.gl built-in limb glow (GlowMesh); tuned for black background + bloom. */
  private readonly globeAtmosphereColor = 'rgba(255, 255, 255, 0.42)';
  /** Thickness in globe-radius units (library default 0.15). */
  private readonly globeAtmosphereAltitude = 0.04;
  /**
   * Focus mode: bloom off — day texture is normally capped at `globeDayTextureBloomCap` (0.28) so
   * clouds don’t bloom; without bloom that cap leaves the planet very dark. Raise cap in Focus only.
   */
  private readonly focusGlobeDayTextureCap = 0.98;
  /** Extra multiplier after mix (night + day). */
  private readonly focusGlobeLuminanceGain = 1.72;

  private readonly geoJsonUrl =
    'https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson';
  /**
   * Equirectangular day + night (NASA Blue Marble + night lights), bundled under `public/globe/`.
   * Blended with a real-time terminator (see globe.gl day-night-cycle example).
   */
  private readonly globeDayTextureUrl = '/globe/nasa-blue-marble.jpg';
  private readonly globeNightTextureUrl = '/globe/nasa-earth-at-night.jpg';

  private streamPoints: GlobeStreamPoint[] = [];
  private radioPoints: GlobeRadioPoint[] = [];
  /** Poll LucentApi for live streams and refresh markers (see `startStreamsRefreshTimer`). */
  private readonly streamsRefreshIntervalMs = 60_000;
  private streamsRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  /** Radio catalogue changes slowly — refresh occasionally. */
  private readonly radioRefreshIntervalMs = 3_600_000;
  private radioRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private dayNightMaterial: THREE.ShaderMaterial | null = null;
  private dayNightRaf = 0;
  private currentAltitude = this.initialGlobeAltitude;
  private lastFocusedMarkerId: string | null = null;
  private initialStreamHandled = false;
  private initialRadioHandled = false;
  /** First streams HTTP finished (so `?stream=` can resolve or be abandoned). */
  private streamsInitialFetchCompleted = false;
  /** First radio search finished (so `?radio=` can resolve or be abandoned). */
  private radioInitialFetchCompleted = false;

  private layoutObserver: ResizeObserver | null = null;
  private layoutSyncRaf = 0;
  private readonly windowResizeHandler = (): void => this.scheduleGlobeLayoutSync();
  /** Shared cylinder body (three-globe points use the same layout). */
  private streamCylinderSharedGeometry: THREE.BufferGeometry | null = null;
  /** Shared invisible material for pick cylinders (`visible` stays true so Raycaster hits them). */
  private streamMarkerHitMaterial: THREE.MeshBasicMaterial | null = null;
  private readonly tmpGlobeCenter = new THREE.Vector3();

  /** Coalesce resize / CSS width transitions to one WebGL setSize per frame */
  private scheduleGlobeLayoutSync(): void {
    if (!this.alive) return;
    if (this.layoutSyncRaf) return;
    this.layoutSyncRaf = requestAnimationFrame(() => {
      this.layoutSyncRaf = 0;
      this.syncGlobeLayout();
    });
  }

  constructor(
    private readonly ngZone: NgZone,
    private readonly http: HttpClient,
    private readonly radioBrowser: RadioBrowserService,
  ) {}

  ngAfterViewInit(): void {
    this.ngZone.runOutsideAngular(() => this.initGlobe());
  }

  ngOnChanges(changes: SimpleChanges): void {
    this.applyOrbitPolicies();
    this.syncSelectedMapFocus();
    if (changes['selectedStream'] || changes['selectedRadio']) {
      queueMicrotask(() => this.refreshMapMarkersOnGlobe());
    }
    if (changes['sidebarOpen'] || changes['focusMode']) {
      queueMicrotask(() => this.scheduleGlobeLayoutSync());
    }
    if (changes['focusMode']) {
      const enteringFocus =
        changes['focusMode'].currentValue === true &&
        changes['focusMode'].previousValue !== true;
      queueMicrotask(() => {
        this.applyFocusModeRendering();
        if (enteringFocus) {
          this.resetGlobeToInitialViewForFocus();
        }
      });
    }
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.stopStreamsRefreshTimer();
    this.stopRadioRefreshTimer();
    if (this.dayNightRaf) cancelAnimationFrame(this.dayNightRaf);
    this.dayNightRaf = 0;
    this.dayNightMaterial = null;
    if (this.rotateTimer !== null) clearTimeout(this.rotateTimer);
    if (this.layoutSyncRaf) cancelAnimationFrame(this.layoutSyncRaf);
    if (this.layoutObserver) {
      this.layoutObserver.disconnect();
      this.layoutObserver = null;
    }
    window.removeEventListener('resize', this.windowResizeHandler);

    if (this.globe) {
      try {
        this.globe._destructor();
      } catch {
        /* ignore */
      }
      this.globe = null;
      delete (globalThis as unknown as { globe?: GlobeInstance }).globe;
    }
    this.globeHost.nativeElement.replaceChildren();
  }

  private initGlobe(): void {
    this.alive = true;
    this.configureMarkerHitTargets();
    const el = this.globeHost.nativeElement;

    this.layoutObserver = new ResizeObserver(() => this.scheduleGlobeLayoutSync());
    this.layoutObserver.observe(el);
    window.addEventListener('resize', this.windowResizeHandler);

    void this.preloadGlobeAssets().then((preload) => {
      if (!this.alive) {
        preload?.disposeTextures();
        this.ngZone.run(() => {
          this.globeLoading = false;
        });
        return;
      }
      if (!preload) {
        console.error('Globe preload failed; skipping globe init.');
        this.ngZone.run(() => {
          this.globeLoading = false;
        });
        return;
      }
      this.countryFeatures = preload.countryFeatures;
      this.borderPaths = preload.borderPaths;
      this.instantiateGlobe(el, preload);
      this.syncSelectedMapFocus();
      void this.fetchAndApplyStreams(true);
      void this.fetchAndApplyRadio(true);
      this.startStreamsRefreshTimer();
      this.startRadioRefreshTimer();
    });
  }

  private async preloadGlobeAssets(): Promise<GlobeAssetPreload | null> {
    const loader = new THREE.TextureLoader();
    const geoJsonPromise = fetch(this.geoJsonUrl)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ features: GeoFeature[] }>;
      })
      .catch((err) => {
        console.error('GeoJSON fetch failed:', err);
        return { features: [] as GeoFeature[] };
      });

    let dayTex: THREE.Texture;
    let nightTex: THREE.Texture;
    let geoData: { features: GeoFeature[] };
    try {
      [dayTex, nightTex, geoData] = await Promise.all([
        loader.loadAsync(this.globeDayTextureUrl),
        loader.loadAsync(this.globeNightTextureUrl),
        geoJsonPromise,
      ]);
    } catch (err) {
      console.error('Globe day/night textures / GeoJSON preload failed:', err);
      return null;
    }

    const countryFeatures = geoData.features.filter((f) => f.properties.ISO_A2 !== 'AQ');
    const borderPaths = geojsonToBorderPaths(countryFeatures);

    return {
      dayTex,
      nightTex,
      countryFeatures,
      borderPaths,
      disposeTextures: () => {
        dayTex.dispose();
        nightTex.dispose();
      },
    };
  }

  /** Loads `/api/streams` and updates markers. `isInitial` gates `?stream=` deep-link resolution. */
  private async fetchAndApplyStreams(isInitial: boolean): Promise<void> {
    if (!this.alive) return;
    const rows = await firstValueFrom(
      this.http.get<StreamDto[]>(environment.streamsUrl).pipe(
        catchError((err) => {
          console.error('Streams API failed:', err);
          return of([] as StreamDto[]);
        }),
      ),
    );
    if (!this.alive) return;
    this.streamPoints = this.streamDtosToPoints(rows);
    if (isInitial) this.streamsInitialFetchCompleted = true;
    this.ngZone.run(() => this.streamsCatalogChange.emit(this.streamPoints.slice()));
    if (this.globe) {
      this.refreshMapMarkersOnGlobe();
      this.syncSelectedMapFocus();
    }
    this.tryEmitInitialStreamQuery();
  }

  /** Loads Radio Browser search and updates markers. `isInitial` gates `?radio=` deep-link resolution. */
  private async fetchAndApplyRadio(isInitial: boolean): Promise<void> {
    if (!this.alive) return;
    const rows = await firstValueFrom(this.radioBrowser.searchStationsWithGeo());
    if (!this.alive) return;
    this.radioPoints = rows;
    if (isInitial) this.radioInitialFetchCompleted = true;
    if (this.globe) {
      this.refreshMapMarkersOnGlobe();
      this.syncSelectedMapFocus();
    }
    void this.tryEmitInitialRadioQuery();
  }

  private streamDtosToPoints(rows: StreamDto[]): GlobeStreamPoint[] {
    return rows
      .map((r) => toGlobeStreamPoint(r))
      .filter((p): p is GlobeStreamPoint => p !== null);
  }

  private startStreamsRefreshTimer(): void {
    this.stopStreamsRefreshTimer();
    this.streamsRefreshIntervalId = setInterval(() => {
      if (!this.alive || !this.globe) return;
      void this.refreshStreamsFromApi();
    }, this.streamsRefreshIntervalMs);
  }

  private stopStreamsRefreshTimer(): void {
    if (this.streamsRefreshIntervalId !== null) {
      clearInterval(this.streamsRefreshIntervalId);
      this.streamsRefreshIntervalId = null;
    }
  }

  private startRadioRefreshTimer(): void {
    this.stopRadioRefreshTimer();
    this.radioRefreshIntervalId = setInterval(() => {
      if (!this.alive || !this.globe) return;
      void this.refreshRadioFromApi();
    }, this.radioRefreshIntervalMs);
  }

  private stopRadioRefreshTimer(): void {
    if (this.radioRefreshIntervalId !== null) {
      clearInterval(this.radioRefreshIntervalId);
      this.radioRefreshIntervalId = null;
    }
  }

  private async refreshRadioFromApi(): Promise<void> {
    await this.fetchAndApplyRadio(false);
  }

  private async refreshStreamsFromApi(): Promise<void> {
    await this.fetchAndApplyStreams(false);
  }

  private instantiateGlobe(el: HTMLElement, preload: GlobeAssetPreload): void {
    this.globe = new Globe(el, {
      waitForGlobeReady: true,
      // Library tweens start when `globeImageUrl` is null (sync onReady); long sync digests then
      // advance Tween time in one step. We preload, then run the same motion in `dayNightTick`.
      animateIn: false,
      rendererConfig: {
        alpha: true,
        antialias: false,
        powerPreference: 'high-performance',
        stencil: false,
        depth: true,
      },
    });

    queueMicrotask(() => this.syncGlobeLayout());

    const globe = this.globe;
    (globalThis as unknown as { globe?: GlobeInstance }).globe = globe;

    globe.backgroundColor('#000000');
    globe.showGraticules(false);
    globe.showGlobe(true);
    globe.globeImageUrl(null as unknown as string);

    globe
      .pointsData([])
      .customThreeObject((d: object) =>
        this.createMapMarkerGroup(d as GlobeMapPoint),
      )
      .customThreeObjectUpdate((obj, d) =>
        this.updateMapMarkerGroup(
          obj as THREE.Group,
          d as GlobeMapPoint,
          globe.getGlobeRadius(),
        ),
      );

    globe.onZoom((pov) => {
      const { altitude, lat, lng } = pov as {
        altitude: number;
        lat: number;
        lng: number;
      };
      if (this.dayNightMaterial) {
        this.dayNightMaterial.uniforms['globeRotation'].value.set(lng, lat);
      }
      this.onGlobeAltitudeChanged(globe, altitude);
    });

    globe.onCustomLayerClick((point) => {
      const p = point as GlobeMapPoint | null;
      if (!p) return;
      void this.onMapMarkerClicked(p);
    });

    globe.onCustomLayerHover((point) => {
      const id = point ? mapPointMarkerId(point as GlobeMapPoint) : null;
      if (id === this.hoveredMarkerId) return;
      this.hoveredMarkerId = id;
      this.refreshMapMarkersOnGlobe();
    });

    globe.onGlobeReady(() => {
      this.applyRendererPerformance(globe);
      this.configureBloom(globe);

      {
        const controlsEarly = globe.controls?.();
        if (controlsEarly) {
          const globeR = globe.getGlobeRadius();
          controlsEarly.minDistance = globeR * (1 + this.minCameraAltitude);
        }
      }

      const mat = createDayNightGlobeMaterial(
        preload.dayTex,
        preload.nightTex,
        this.globeDayTextureBloomCap,
      );
      this.dayNightMaterial = mat;
      const [sx, sy] = sunSubSolarPoint(Date.now());
      mat.uniforms['sunPosition'].value.set(sx, sy);
      const pov = globe.pointOfView();
      mat.uniforms['globeRotation'].value.set(pov.lng, pov.lat);
      globe.globeMaterial(mat);

      /*
       * Defer non-focus atmosphere / bloom / brightness to after globe.gl finishes internal setup.
       * Synchronous apply here often leaves the default thick atmosphere limb until something
       * (e.g. exiting Focus mode) calls applyFocusModeRendering again — same fix as focusMode
       * changes, which already use queueMicrotask.
       */
      queueMicrotask(() => {
        if (!this.alive || !this.globe) return;
        this.applyFocusModeRendering();
      });

      this.rotateTimer = setTimeout(() => {
        this.autoRotateEnabled = true;
        const c = globe.controls?.();
        if (c) {
          c.enableDamping = true;
          c.dampingFactor = 0.06;
          c.autoRotateSpeed = this.orbitAutoRotateSpeedDefault;
        }
        this.applyOrbitPolicies();
      }, this.rotateDelayMs);

      this.syncGlobeLayout();
      this.refreshMapMarkersOnGlobe();

      // Initial pose; clock starts in `scheduleRevealGlobeAndStartIntro` after loading UI peels away
      // so elapsed time is not swallowed by the same long task / first composite.
      const scene = globe.scene();
      scene.scale.setScalar(1e-6);
      scene.setRotationFromAxisAngle(this.introRotAxis, Math.PI * 2);
      this.introScene = scene;
      this.introAnimationActive = false;

      this.dayNightTick();
      this.onGlobeAltitudeChanged(globe, globe.pointOfView().altitude);
      this.scheduleRevealGlobeAndStartIntro(globe);
    });

    globe.pointOfView(
      {
        lat: this.initialGlobeLat,
        lng: this.initialGlobeLng,
        altitude: this.initialGlobeAltitude,
      },
      0,
    );
  }

  /**
   * Drop the loading layer after the browser has painted idle frames, force one WebGL draw,
   * then arm the intro so `performance.now()` deltas match visible animation frames.
   */
  private scheduleRevealGlobeAndStartIntro(globe: GlobeInstance): void {
    requestAnimationFrame(() => {
      if (!this.alive) return;
      requestAnimationFrame(() => {
        if (!this.alive) return;
        try {
          globe.renderer().render(globe.scene(), globe.camera());
        } catch {
          /* ignore */
        }
        if (this.alive && this.globe) {
          this.applyFocusModeRendering();
        }
        this.introAnimationActive = true;
        this.introAnimationStartTime = performance.now();
        this.ngZone.run(() => {
          this.globeLoading = false;
        });
      });
    });
  }

  private applyRendererPerformance(globe: GlobeInstance): void {
    const r = globe.renderer();
    const dpr =
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    // Retina-class without 2–3× fill-rate of uncapped DPR
    r.setPixelRatio(Math.min(dpr, 1.5));
  }

  /**
   * Focus mode: transparent clear, no atmosphere halo, no border paths (they sit above the
   * surface and bloom as a dark ring), and bloom disabled so EffectComposer keeps alpha.
   */
  /** Fly to the same POV as first load — used when entering Focus after zooming on the main globe. */
  private resetGlobeToInitialViewForFocus(): void {
    if (!this.globe || !this.focusMode) return;
    this.globe.pointOfView(
      {
        lat: this.initialGlobeLat,
        lng: this.initialGlobeLng,
        altitude: this.initialGlobeAltitude,
      },
      this.focusModeInitialViewTransitionMs,
    );
  }

  private applyFocusModeRendering(): void {
    this.applyGlobeBackdropMode();
    if (!this.globe) return;
    this.applyAtmosphereForFocus(this.globe);
    this.applyGeoLayers(this.globe);
    this.applyBloomForFocus();
    this.applyFocusGlobeBrightness();
  }

  /**
   * Updates uniforms on the **live** globe material from globe.gl — `this.dayNightMaterial` can
   * diverge from `globe.globeMaterial()` after internal updates, so edits would be no-ops.
   */
  private applyFocusGlobeBrightness(): void {
    if (!this.globe) return;
    const mat = this.globe.globeMaterial() as THREE.ShaderMaterial;
    if (!(mat instanceof THREE.ShaderMaterial) || !mat.uniforms) return;

    const gain = mat.uniforms['luminanceGain'];
    const cap = mat.uniforms['globeDayTextureCap'];
    if (gain) {
      gain.value = this.focusMode ? this.focusGlobeLuminanceGain : 1.0;
    }
    if (cap) {
      cap.value = this.focusMode
        ? this.focusGlobeDayTextureCap
        : this.globeDayTextureBloomCap;
    }
    this.dayNightMaterial = mat;
  }

  private applyGlobeBackdropMode(): void {
    if (!this.globe) return;
    if (this.focusMode) {
      this.globe.backgroundColor('rgba(0,0,0,0)');
    } else {
      this.globe.backgroundColor('#000000');
    }
    const canvas = this.globe.renderer()?.domElement as HTMLCanvasElement | undefined;
    if (canvas) {
      canvas.style.background = this.focusMode ? 'transparent' : '';
    }
  }

  private applyAtmosphereForFocus(globe: GlobeInstance): void {
    if (this.focusMode) {
      globe.showAtmosphere(false);
    } else {
      globe
        .showAtmosphere(true)
        .atmosphereColor(this.globeAtmosphereColor)
        .atmosphereAltitude(this.globeAtmosphereAltitude);
    }
  }

  private applyGeoLayers(globe: GlobeInstance): void {
    const feats = this.focusMode ? [] : (this.countryFeatures ?? []);
    const paths = this.focusMode ? [] : (this.borderPaths ?? []);
    globe
      .polygonsData(feats)
      .polygonAltitude(() => 0.0015)
      .polygonCapColor(() => 'rgba(0,0,0,0)')
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(() => null)
      .polygonsTransitionDuration(0)
      .pathsData(paths)
      .pathPoints('pnts')
      .pathPointLat((p: [number, number]) => p[0])
      .pathPointLng((p: [number, number]) => p[1])
      .pathPointAlt((path: object) => {
        const style = (path as BorderPath).style;
        if (style === 'glow1') return 0.0104;
        if (style === 'glow2') return 0.0108;
        return 0.01;
      })
      .pathStroke((path: object) => {
        const style = (path as BorderPath).style;
        if (style === 'glow1') return 0.6;
        if (style === 'glow2') return 0.85;
        return null;
      })
      .pathColor((path: object) => {
        const style = (path as BorderPath).style;
        if (style === 'glow1') return 'rgba(150,225,255,0.22)';
        if (style === 'glow2') return 'rgba(130,210,240,0.14)';
        return 'rgba(240,245,250,0.42)';
      })
      .pathResolution(1)
      .pathTransitionDuration(0);
  }

  private applyBloomForFocus(): void {
    if (!this.globeBloomPass) return;
    this.globeBloomPass.enabled = !this.focusMode;
  }

  private onGlobeAltitudeChanged(globe: GlobeInstance, altitude: number): void {
    const prevAlt = this.currentAltitude;
    this.currentAltitude = altitude;
    if (Math.abs(altitude - prevAlt) > 1e-5) {
      this.refreshMapMarkersOnGlobe();
    }
    this.applyOrbitPolicies();
  }

  /** Sun + optional globe build-in (see `animateIn: false` + `stepGlobeIntroAnimation`). */
  private dayNightTick = (): void => {
    if (!this.alive) return;
    this.dayNightRaf = requestAnimationFrame(this.dayNightTick);

    this.stepGlobeIntroAnimation();

    if (this.dayNightMaterial) {
      const [sx, sy] = sunSubSolarPoint(Date.now());
      this.dayNightMaterial.uniforms['sunPosition'].value.set(sx, sy);
    }
  };

  private stepGlobeIntroAnimation(): void {
    if (!this.introAnimationActive || !this.introScene) return;
    const elapsed = performance.now() - this.introAnimationStartTime;
    const ps = Math.min(1, elapsed / this.introScaleDurationMs);
    const pr = Math.min(1, elapsed / this.introRotationDurationMs);
    const k = THREE.MathUtils.lerp(1e-6, 1, easeOutQuad(ps));
    this.introScene.scale.setScalar(k);
    const angle = THREE.MathUtils.lerp(Math.PI * 2, 0, easeOutQuint(pr));
    this.introScene.setRotationFromAxisAngle(this.introRotAxis, angle);
    if (elapsed >= this.introRotationDurationMs) {
      this.introScene.scale.setScalar(1);
      this.introScene.rotation.set(0, 0, 0);
      this.introAnimationActive = false;
      this.introScene = null;
    }
  }

  private configureBloom(globe: GlobeInstance): void {
    if (this.bloomConfigured) return;
    const composer = globe.postProcessingComposer?.();
    if (!composer) return;

    const size = new THREE.Vector2();
    globe.renderer().getSize(size);
    // Bloom at reduced res — main cost is extra fullscreen passes
    size.multiplyScalar(0.36);

    // Real glow comes from bloom, not thick line stacking.
    const bloomPass = new UnrealBloomPass(
      size,
      this.globeBloomStrength,
      this.globeBloomRadius,
      this.globeBloomThreshold,
    );
    this.globeBloomPass = bloomPass;
    composer.addPass(bloomPass);
    this.bloomConfigured = true;
  }

  private getStreamCylinderGeometry(): THREE.BufferGeometry {
    if (!this.streamCylinderSharedGeometry) {
      const g = new THREE.CylinderGeometry(1, 1, 1, 12);
      g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      g.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -0.5));
      this.streamCylinderSharedGeometry = g;
    }
    return this.streamCylinderSharedGeometry;
  }

  /** Same convention as three-globe `polar2Cartesian` (globe radius R, altitude as fraction of R). */
  private streamPolarToPosition(
    lat: number,
    lng: number,
    relAltitude: number,
    globeRadius: number,
    target: THREE.Vector3,
  ): void {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(90 - lng);
    const r = globeRadius * (1 + relAltitude);
    const sinPhi = Math.sin(phi);
    target.set(
      r * sinPhi * Math.cos(theta),
      r * Math.cos(phi),
      r * sinPhi * Math.sin(theta),
    );
  }

  private getStreamMarkerHitMaterial(): THREE.MeshBasicMaterial {
    if (!this.streamMarkerHitMaterial) {
      this.streamMarkerHitMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }
    return this.streamMarkerHitMaterial;
  }

  /** Touch / stylus-primary devices get a wider invisible cylinder (see `updateMapMarkerGroup`). */
  private configureMarkerHitTargets(): void {
    this.markerHitTargetRadiusFactor = this.markerHitTargetRadiusFactorFinePointer;
    this.markerHitTargetHeightFactor = this.markerHitTargetHeightFactorFinePointer;
    if (typeof matchMedia === 'undefined') return;
    if (matchMedia('(any-pointer: coarse)').matches) {
      this.markerHitTargetRadiusFactor = this.markerHitTargetRadiusFactorCoarsePointer;
      this.markerHitTargetHeightFactor = this.markerHitTargetHeightFactorCoarsePointer;
    }
  }

  /** Wider/taller invisible cylinder for picking; visible bar is a child (globe.gl resolves `__data` on the group). */
  private createMapMarkerGroup(d: GlobeMapPoint): THREE.Group {
    const group = new THREE.Group();
    const geom = this.getStreamCylinderGeometry();
    const hit = new THREE.Mesh(geom, this.getStreamMarkerHitMaterial());
    hit.name = this.streamMarkerHitName;
    const visMat = new THREE.MeshLambertMaterial({ transparent: false });
    if (isGlobeRadioPoint(d)) {
      this.applyRadioMarkerAppearance(visMat, d);
    } else {
      this.applyStreamMarkerAppearance(visMat, d);
    }
    const vis = new THREE.Mesh(geom, visMat);
    vis.name = this.streamMarkerVisibleName;
    group.add(hit);
    group.add(vis);
    return group;
  }

  /** Hover or current sidebar selection — keeps glow on the active marker. */
  private streamMarkerHighlighted(d: GlobeStreamPoint): boolean {
    return (
      d.channelLogin === this.hoveredMarkerId ||
      (this.selectedStream !== null &&
        d.channelLogin === this.selectedStream.channelLogin)
    );
  }

  private radioMarkerHighlighted(d: GlobeRadioPoint): boolean {
    return (
      d.markerId === this.hoveredMarkerId ||
      (this.selectedRadio !== null &&
        d.markerId === this.selectedRadio.station.markerId)
    );
  }

  private applyRadioMarkerAppearance(
    mat: THREE.MeshLambertMaterial,
    d: GlobeRadioPoint,
  ): void {
    const hi = this.radioMarkerHighlighted(d);
    mat.color.set(hi ? this.radioMarkerHoverColor : this.radioMarkerColor);
    mat.emissive.copy(mat.color);
    mat.emissiveIntensity = hi
      ? this.radioMarkerHoverEmissiveIntensity
      : this.radioMarkerEmissiveIntensity;
  }

  private applyStreamMarkerAppearance(
    mat: THREE.MeshLambertMaterial,
    d: GlobeStreamPoint,
  ): void {
    const highlighted = this.streamMarkerHighlighted(d);
    const p = (d.platform ?? 'twitch').toLowerCase();
    const base =
      p === 'youtube'
        ? this.streamMarkerColorYoutube
        : p === 'kick'
          ? this.streamMarkerColorKick
          : this.streamMarkerColorTwitch;
    const hi =
      p === 'youtube'
        ? this.streamMarkerHoverColorYoutube
        : p === 'kick'
          ? this.streamMarkerHoverColorKick
          : this.streamMarkerHoverColorTwitch;
    mat.color.set(highlighted ? hi : base);
    mat.emissive.copy(mat.color);
    mat.emissiveIntensity = highlighted
      ? this.streamMarkerHoverEmissiveIntensity
      : this.streamMarkerEmissiveIntensity;
  }

  private updateMapMarkerGroup(
    group: THREE.Group,
    d: GlobeMapPoint,
    globeRadius: number,
  ): void {
    const vis = group.getObjectByName(
      this.streamMarkerVisibleName,
    ) as THREE.Mesh | undefined;
    const hit = group.getObjectByName(
      this.streamMarkerHitName,
    ) as THREE.Mesh | undefined;
    if (!vis || !hit) return;

    const mat = vis.material as THREE.MeshLambertMaterial;
    if (isGlobeRadioPoint(d)) {
      this.applyRadioMarkerAppearance(mat, d);
    } else {
      this.applyStreamMarkerAppearance(mat, d);
    }

    const baseR = this.currentMarkerBaseRadius();
    const hoverR = Math.min(
      this.markerRadiusMax * 1.1,
      baseR * this.markerHoverScale,
    );
    const pxPerDeg = (2 * Math.PI * globeRadius) / 360;

    this.streamPolarToPosition(d.latitude, d.longitude, 0, globeRadius, group.position);

    this.tmpGlobeCenter.set(0, 0, 0);
    if (group.parent) {
      group.parent.localToWorld(this.tmpGlobeCenter);
    }
    group.lookAt(this.tmpGlobeCenter);

    if (isGlobeRadioPoint(d)) {
      const rDeg = this.radioMarkerHighlighted(d) ? hoverR : baseR;
      const rs = Math.min(30, rDeg) * pxPerDeg * this.radioMarkerRadiusScale;
      const h = Math.max(this.radioPointAltitude * globeRadius, 0.08);
      vis.scale.set(rs, rs, h);
      hit.scale.set(
        rs * this.markerHitTargetRadiusFactor,
        rs * this.markerHitTargetRadiusFactor,
        h * this.markerHitTargetHeightFactor,
      );
    } else {
      const alt = this.viewerCountToPointAltitude(d.viewerCount);
      const rDeg = this.streamMarkerHighlighted(d) ? hoverR : baseR;
      const rs = Math.min(30, rDeg) * pxPerDeg;
      const h = Math.max(alt * globeRadius, 0.1);
      vis.scale.set(rs, rs, h);
      hit.scale.set(
        rs * this.markerHitTargetRadiusFactor,
        rs * this.markerHitTargetRadiusFactor,
        h * this.markerHitTargetHeightFactor,
      );
    }
  }

  private mergeMapPoints(): GlobeMapPoint[] {
    return [...this.streamPoints, ...this.radioPoints];
  }

  private refreshMapMarkersOnGlobe(): void {
    if (!this.alive || !this.globe) return;
    this.globe.customLayerData(this.mergeMapPoints());
  }

  /** OrbitControls: Focus = drag rotate only (no zoom/pan); else sidebar + auto-rotate. */
  private applyOrbitPolicies(): void {
    const c = this.globe?.controls?.() as
      | {
          enableZoom?: boolean;
          enableRotate?: boolean;
          enablePan?: boolean;
          autoRotate?: boolean;
          autoRotateSpeed?: number;
        }
      | undefined;
    if (!c) return;
    if (this.focusMode) {
      c.enableZoom = false;
      c.enableRotate = true;
      c.enablePan = false;
      c.autoRotate = true;
      c.autoRotateSpeed = this.orbitAutoRotateSpeedFocus;
      return;
    }
    c.autoRotateSpeed = this.orbitAutoRotateSpeedDefault;
    c.enableZoom = true;
    c.enableRotate = true;
    c.enablePan = true;
    if (this.autoRotateEnabled) {
      c.autoRotate = !this.sidebarOpen;
    }
  }

  private tryEmitInitialStreamQuery(): void {
    if (this.initialStreamHandled || !this.initialStreamQuery?.trim()) return;
    const q = this.initialStreamQuery.trim().toLowerCase();
    const match = this.streamPoints.find(
      (p) => p.channelLogin.toLowerCase() === q,
    );
    if (match) {
      this.initialStreamHandled = true;
      this.ngZone.run(() => this.streamSelected.emit(match));
      return;
    }
    if (!this.streamsInitialFetchCompleted) return;
    this.initialStreamHandled = true;
  }

  private async tryEmitInitialRadioQuery(): Promise<void> {
    if (this.initialRadioHandled || !this.initialRadioQuery?.trim()) return;
    const q = this.initialRadioQuery.trim().toLowerCase();
    const match = this.radioPoints.find(
      (p) => p.stationuuid.toLowerCase() === q,
    );
    if (!match) {
      if (!this.radioInitialFetchCompleted) return;
      this.initialRadioHandled = true;
      return;
    }
    const playUrl = await firstValueFrom(
      this.radioBrowser.notifyStationClick(match.stationuuid),
    );
    if (!this.alive) return;
    this.initialRadioHandled = true;
    this.ngZone.run(() =>
      this.radioSelected.emit({ station: match, playUrl }),
    );
  }

  private async onMapMarkerClicked(p: GlobeMapPoint): Promise<void> {
    if (isGlobeRadioPoint(p)) {
      const playUrl = await firstValueFrom(
        this.radioBrowser.notifyStationClick(p.stationuuid),
      );
      if (!this.alive) return;
      this.ngZone.run(() =>
        this.radioSelected.emit({ station: p, playUrl }),
      );
      return;
    }
    this.ngZone.run(() => this.streamSelected.emit(p));
  }

  /** Match WebGL canvas to host box (sidebar open/resize, window resize). */
  private syncGlobeLayout(): void {
    if (!this.alive || !this.globe) return;
    const box = this.globeHost.nativeElement;
    const w = Math.max(1, Math.floor(box.clientWidth));
    const h = Math.max(1, Math.floor(box.clientHeight));
    this.globe.width(w).height(h);
  }

  private syncSelectedMapFocus(): void {
    if (this.focusMode) {
      return;
    }

    const channel = this.selectedStream?.channelLogin ?? null;
    const idx =
      channel === null || !this.streamPoints.length
        ? -1
        : this.streamPoints.findIndex((p) => p.channelLogin === channel);

    if (channel && idx >= 0) {
      if (!this.globe) return;
      if (this.lastFocusedMarkerId === channel) return;
      const target = this.streamPoints[idx]!;
      this.globe.pointOfView(
        {
          lat: target.latitude,
          lng: target.longitude,
          altitude: this.focusStreamCameraAltitude(),
        },
        this.selectedFocusTransitionMs,
      );
      this.lastFocusedMarkerId = channel;
      return;
    }

    const radioSel = this.selectedRadio?.station ?? null;
    if (radioSel) {
      if (!this.globe) return;
      if (this.lastFocusedMarkerId === radioSel.markerId) return;
      this.globe.pointOfView(
        {
          lat: radioSel.latitude,
          lng: radioSel.longitude,
          altitude: this.focusStreamCameraAltitude(),
        },
        this.selectedFocusTransitionMs,
      );
      this.lastFocusedMarkerId = radioSel.markerId;
      return;
    }

    this.lastFocusedMarkerId = null;
  }

  private currentMarkerBaseRadius(): number {
    // Map POV altitude from closest zoom (`minCameraAltitude`) to default zoom-out — avoids a
    // plateau (old altMin 0.08) where radii stopped shrinking while the camera moved closer.
    const altMin = this.minCameraAltitude;
    const altMax = this.initialGlobeAltitude;
    const t = THREE.MathUtils.clamp(
      (this.currentAltitude - altMin) / Math.max(altMax - altMin, 1e-6),
      0,
      1,
    );
    return this.markerRadiusMin + (this.markerRadiusMax - this.markerRadiusMin) * t;
  }

  /**
   * Cylinder height: linear in viewers up to 1k, then log₁₀ from 1k to the cap so
   * huge channels do not dominate.
   */
  /** POV altitude when flying to a selected stream (must stay above tallest cylinders). */
  private focusStreamCameraAltitude(): number {
    return Math.max(this.minCameraAltitude + 0.06, this.selectedFocusAltitude);
  }

  /** Max `pointAltitude` so cylinder top stays below focus camera (radial clearance). */
  private maxPointAltitudeForFocusZoom(): number {
    const focusAlt = this.focusStreamCameraAltitude();
    return Math.max(
      this.markerAltitudeMin + 1e-4,
      focusAlt - this.markerAltitudeFocusClearance,
    );
  }

  private viewerCountToPointAltitude(viewers: number): number {
    const v0 = Number.isFinite(viewers) ? Math.max(0, viewers) : 0;
    const cap = this.markerViewersAltitudeCap;
    const v = Math.min(v0, cap);
    const h0 = this.markerAltitudeMin;
    const h1 = Math.min(this.markerAltitudeMax, this.maxPointAltitudeForFocusZoom());
    const span = h1 - h0;
    const hLinearTop = h0 + this.markerAltitudeLinearBandFraction * span;
    const vLin = this.markerAltitudeLinearViewerCeiling;

    if (v <= vLin) {
      const t = vLin > 0 ? v / vLin : 0;
      return h0 + t * (hLinearTop - h0);
    }

    const logLo = Math.log10(vLin + 1);
    const logHi = Math.log10(cap + 1);
    const denom = logHi - logLo;
    const tLog =
      denom > 0
        ? THREE.MathUtils.clamp((Math.log10(v + 1) - logLo) / denom, 0, 1)
        : 1;
    return hLinearTop + tLog * (h1 - hLinearTop);
  }
}

function geojsonToBorderPaths(features: GeoFeature[]): BorderPath[] {
  const paths: BorderPath[] = [];

  function addRing(coords: [number, number][]): void {
    if (!coords || coords.length < 2) return;
    const pnts = coords.map(([lng, lat]) => [lat, lng] as [number, number]);
    // Base crisp border line + multi-pass outer glow to fake a soft gradient.
    paths.push({ pnts, style: 'base' });
    paths.push({ pnts, style: 'glow1' });
    paths.push({ pnts, style: 'glow2' });
  }

  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      const rings = g.coordinates as [number, number][][];
      rings.forEach(addRing);
    } else if (g.type === 'MultiPolygon') {
      const polys = g.coordinates as [number, number][][][];
      polys.forEach((poly) => poly.forEach(addRing));
    }
  }
  return paths;
}
