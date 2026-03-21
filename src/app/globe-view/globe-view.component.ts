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

/** Preloaded so the globe intro runs after heavy work; avoids Tween time-skew from long tasks. */
interface GlobeAssetPreload {
  dayTex: THREE.Texture;
  nightTex: THREE.Texture;
  countryFeatures: GeoFeature[];
  borderPaths: BorderPath[];
  streamPoints: GlobeStreamPoint[];
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

  @Input() sidebarOpen = false;
  /** While true, globe width follows inset immediately (sidebar drag resize). */
  @Input() @HostBinding('class.globe-inset-snap') sidebarInsetSnap = false;
  @Input() selectedStream: GlobeStreamPoint | null = null;
  /** First-load `?stream=` login; matched after streams HTTP returns */
  @Input() initialStreamQuery: string | null = null;

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
  private readonly minCameraAltitude = 0.25;
  /** Camera distance in globe radii; larger = more zoomed out */
  private readonly initialGlobeAltitude = 2.65;
  private readonly selectedFocusAltitude = 0.42;
  private readonly selectedFocusTransitionMs = 900;
  private readonly markerRadiusMax = 0.28;
  private readonly markerRadiusMin = 0.005;
  private readonly markerHoverScale = 1.45;
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
  private hoveredChannelLogin: string | null = null;

  private bloomConfigured = false;
  /**
   * UnrealBloom uses screen luminance. Day texture must peak *below* `globeBloomThreshold`
   * (after `globeDayTextureBloomCap`); Twitch purple + border lines sit a bit above after lighting.
   * If glow disappears, lower threshold slightly; if clouds bloom again, lower the day cap.
   */
  private readonly globeDayTextureBloomCap = 0.28;
  private readonly globeBloomStrength = 0.82;
  private readonly globeBloomRadius = 0.55;
  private readonly globeBloomThreshold = 0.34;

  private readonly geoJsonUrl =
    'https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson';
  /**
   * Equirectangular day + night (NASA Blue Marble + night lights), bundled under `public/globe/`.
   * Blended with a real-time terminator (see globe.gl day-night-cycle example).
   */
  private readonly globeDayTextureUrl = '/globe/nasa-blue-marble.jpg';
  private readonly globeNightTextureUrl = '/globe/nasa-earth-at-night.jpg';

  private streamPoints: GlobeStreamPoint[] = [];
  /** Poll LucentApi for live streams and refresh markers (see `startStreamsRefreshTimer`). */
  private readonly streamsRefreshIntervalMs = 60_000;
  private streamsRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private dayNightMaterial: THREE.ShaderMaterial | null = null;
  private dayNightRaf = 0;
  private currentAltitude = this.initialGlobeAltitude;
  private lastFocusedChannelLogin: string | null = null;
  private initialStreamHandled = false;

  private layoutObserver: ResizeObserver | null = null;
  private layoutSyncRaf = 0;
  private readonly windowResizeHandler = (): void => this.scheduleGlobeLayoutSync();
  /** Shared cylinder body (three-globe points use the same layout). */
  private streamCylinderSharedGeometry: THREE.BufferGeometry | null = null;
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
  ) {}

  ngAfterViewInit(): void {
    this.ngZone.runOutsideAngular(() => this.initGlobe());
  }

  ngOnChanges(changes: SimpleChanges): void {
    this.syncAutoRotate();
    this.syncSelectedStream();
    if (changes['sidebarOpen']) {
      queueMicrotask(() => this.scheduleGlobeLayoutSync());
    }
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.stopStreamsRefreshTimer();
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
      this.streamPoints = preload.streamPoints;
      this.instantiateGlobe(el, preload);
      this.syncSelectedStream();
      this.tryEmitInitialStreamQuery();
      this.startStreamsRefreshTimer();
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

    const streamsPromise = firstValueFrom(
      this.http.get<StreamDto[]>(environment.streamsUrl).pipe(
        catchError((err) => {
          console.error('Streams API failed:', err);
          return of([] as StreamDto[]);
        }),
      ),
    );

    let dayTex: THREE.Texture;
    let nightTex: THREE.Texture;
    try {
      [dayTex, nightTex] = await Promise.all([
        loader.loadAsync(this.globeDayTextureUrl),
        loader.loadAsync(this.globeNightTextureUrl),
      ]);
    } catch (err) {
      console.error('Globe day/night textures failed:', err);
      return null;
    }

    const [geoData, streamRows] = await Promise.all([geoJsonPromise, streamsPromise]);

    const countryFeatures = geoData.features.filter((f) => f.properties.ISO_A2 !== 'AQ');
    const borderPaths = geojsonToBorderPaths(countryFeatures);
    const streamPoints = this.streamDtosToPoints(streamRows);

    return {
      dayTex,
      nightTex,
      countryFeatures,
      borderPaths,
      streamPoints,
      disposeTextures: () => {
        dayTex.dispose();
        nightTex.dispose();
      },
    };
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

  private async refreshStreamsFromApi(): Promise<void> {
    if (!this.alive || !this.globe) return;
    const rows = await firstValueFrom(
      this.http.get<StreamDto[]>(environment.streamsUrl).pipe(
        catchError((err) => {
          console.error('Streams refresh failed:', err);
          return of([] as StreamDto[]);
        }),
      ),
    );
    if (!this.alive || !this.globe) return;
    this.streamPoints = this.streamDtosToPoints(rows);
    this.refreshStreamMarkersOnGlobe();
    this.syncSelectedStream();
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
    globe.showAtmosphere(false);
    globe.showGraticules(false);
    globe.showGlobe(true);
    globe.globeImageUrl(null as unknown as string);

    globe
      .pointsData([])
      .customThreeObject((d: object) =>
        this.createStreamMarkerMesh(d as GlobeStreamPoint),
      )
      .customThreeObjectUpdate((obj, d) =>
        this.updateStreamMarkerMesh(
          obj as THREE.Mesh,
          d as GlobeStreamPoint,
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
      this.ngZone.run(() => this.streamSelected.emit(point as GlobeStreamPoint));
    });

    globe.onCustomLayerHover((point) => {
      const login = point ? (point as GlobeStreamPoint).channelLogin : null;
      if (login === this.hoveredChannelLogin) return;
      this.hoveredChannelLogin = login;
      this.refreshStreamMarkersOnGlobe();
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

      globe
        .polygonsData(preload.countryFeatures)
        .polygonAltitude(() => 0.0015)
        .polygonCapColor(() => 'rgba(0,0,0,0)')
        .polygonSideColor(() => 'rgba(0,0,0,0)')
        .polygonStrokeColor(() => null)
        .polygonsTransitionDuration(0)
        .pathsData(preload.borderPaths)
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

      this.rotateTimer = setTimeout(() => {
        this.autoRotateEnabled = true;
        const c = globe.controls?.();
        if (c) {
          c.enableDamping = true;
          c.dampingFactor = 0.06;
          c.autoRotate = !this.sidebarOpen;
          c.autoRotateSpeed = 0.04;
        }
      }, this.rotateDelayMs);

      this.syncGlobeLayout();
      this.refreshStreamMarkersOnGlobe();

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

  private onGlobeAltitudeChanged(globe: GlobeInstance, altitude: number): void {
    const prevAlt = this.currentAltitude;
    this.currentAltitude = altitude;
    if (Math.abs(altitude - prevAlt) > 1e-5) {
      this.refreshStreamMarkersOnGlobe();
    }
    const controls = globe.controls?.();
    if (controls && this.autoRotateEnabled) {
      controls.autoRotate = !this.sidebarOpen;
    }
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

  private createStreamMarkerMesh(d: GlobeStreamPoint): THREE.Mesh {
    const mat = new THREE.MeshLambertMaterial({ transparent: false });
    this.applyStreamMarkerAppearance(mat, d);
    return new THREE.Mesh(this.getStreamCylinderGeometry(), mat);
  }

  private applyStreamMarkerAppearance(
    mat: THREE.MeshLambertMaterial,
    d: GlobeStreamPoint,
  ): void {
    const hover = d.channelLogin === this.hoveredChannelLogin;
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
    mat.color.set(hover ? hi : base);
    mat.emissive.copy(mat.color);
    mat.emissiveIntensity = hover
      ? this.streamMarkerHoverEmissiveIntensity
      : this.streamMarkerEmissiveIntensity;
  }

  private updateStreamMarkerMesh(
    mesh: THREE.Mesh,
    d: GlobeStreamPoint,
    globeRadius: number,
  ): void {
    const mat = mesh.material as THREE.MeshLambertMaterial;
    this.applyStreamMarkerAppearance(mat, d);

    const alt = this.viewerCountToPointAltitude(d.viewerCount);
    const baseR = this.currentMarkerBaseRadius();
    const hoverR = Math.min(
      this.markerRadiusMax * 1.1,
      baseR * this.markerHoverScale,
    );
    const rDeg = d.channelLogin === this.hoveredChannelLogin ? hoverR : baseR;
    const pxPerDeg = (2 * Math.PI * globeRadius) / 360;

    this.streamPolarToPosition(d.latitude, d.longitude, 0, globeRadius, mesh.position);

    this.tmpGlobeCenter.set(0, 0, 0);
    if (mesh.parent) {
      mesh.parent.localToWorld(this.tmpGlobeCenter);
    }
    mesh.lookAt(this.tmpGlobeCenter);

    const rs = Math.min(30, rDeg) * pxPerDeg;
    const h = Math.max(alt * globeRadius, 0.1);
    mesh.scale.set(rs, rs, h);
  }

  private refreshStreamMarkersOnGlobe(): void {
    if (!this.alive || !this.globe) return;
    this.globe.customLayerData(this.streamPoints);
  }

  private syncAutoRotate(): void {
    if (!this.autoRotateEnabled) return;
    const controls = this.globe?.controls?.();
    if (!controls) return;
    controls.autoRotate = !this.sidebarOpen;
  }

  private tryEmitInitialStreamQuery(): void {
    if (this.initialStreamHandled || !this.initialStreamQuery?.trim()) return;
    const q = this.initialStreamQuery.trim().toLowerCase();
    this.initialStreamHandled = true;
    const match = this.streamPoints.find(
      (p) => p.channelLogin.toLowerCase() === q,
    );
    if (match) {
      this.ngZone.run(() => this.streamSelected.emit(match));
    }
  }

  /** Match WebGL canvas to host box (sidebar open/resize, window resize). */
  private syncGlobeLayout(): void {
    if (!this.alive || !this.globe) return;
    const box = this.globeHost.nativeElement;
    const w = Math.max(1, Math.floor(box.clientWidth));
    const h = Math.max(1, Math.floor(box.clientHeight));
    this.globe.width(w).height(h);
  }

  private syncSelectedStream(): void {
    const channel = this.selectedStream?.channelLogin ?? null;
    const idx =
      channel === null || !this.streamPoints.length
        ? -1
        : this.streamPoints.findIndex((p) => p.channelLogin === channel);

    if (!channel || idx < 0) {
      this.lastFocusedChannelLogin = null;
      return;
    }
    if (!this.globe) return;
    if (this.lastFocusedChannelLogin === channel) return;

    const target = this.streamPoints[idx];
    if (!target) return;

    this.globe.pointOfView(
      {
        lat: target.latitude,
        lng: target.longitude,
        altitude: this.focusStreamCameraAltitude(),
      },
      this.selectedFocusTransitionMs,
    );
    this.lastFocusedChannelLogin = channel;
  }

  private currentMarkerBaseRadius(): number {
    // Shrink continuously as camera altitude decreases, with a hard minimum radius.
    const altMin = 0.08;
    const altMax = this.initialGlobeAltitude;
    const t = THREE.MathUtils.clamp((this.currentAltitude - altMin) / (altMax - altMin), 0, 1);
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
    // Single soft halo (was two passes — fewer line draws per frame)
    paths.push({ pnts, style: 'glow1' });
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
