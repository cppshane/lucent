import {
  ChangeDetectorRef,
  Component,
  HostBinding,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { GlobeViewComponent } from './globe-view/globe-view.component';
import type { GlobeRadioSelection } from './radio.models';
import { buildStreamEmbedUrl } from './stream-embed-url';
import type { GlobeStreamPoint } from './stream.models';
import { FocusPomodoroComponent } from './focus-pomodoro/focus-pomodoro.component';
import { StreamSidebarComponent } from './stream-sidebar/stream-sidebar.component';

/**
 * When Focus mode is on but no stream is selected, the first `channelLogin` in this list that
 * exists in the live catalog is auto-selected. Order matters: Shinjuku (manual EarthCam Tokyo).
 * Keys match `GlobeStreamPoint.channelLogin` (e.g. `yt-{videoId}` for YouTube).
 */
const FOCUS_FALLBACK_STREAM_KEYS: readonly string[] = ['yt-lA6TaaMGgDo'];

/** Covers layout + WebGL churn while entering/leaving Focus mode */
const FOCUS_MODE_TRANSITION_MS = 1100;
const FOCUS_MODE_TRANSITION_MS_REDUCED = 280;

@Component({
  selector: 'app-root',
  imports: [FocusPomodoroComponent, GlobeViewComponent, StreamSidebarComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild(StreamSidebarComponent) private streamSidebar?: StreamSidebarComponent;

  private focusTransitionClearId: ReturnType<typeof setTimeout> | null = null;

  /**
   * First focus embed after a cold load with `?focus=` in the URL — use muted autoplay so
   * playback can start without a user gesture; cleared after the first successful embed URL.
   */
  private focusEmbedColdStartMutedAutoplay = false;

  /** One Pomodoro "Start" reload per focus session (pause/resume must not keep reloading the iframe). */
  private focusEmbedPomodoroAutoplayReloadUsed = false;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly sanitizer: DomSanitizer,
  ) {}

  ngOnDestroy(): void {
    if (this.focusTransitionClearId !== null) {
      clearTimeout(this.focusTransitionClearId);
      this.focusTransitionClearId = null;
    }
  }

  /** Full-screen veil while toggling Focus mode (hides WebGL/layout churn). */
  focusModeTransitionOverlay = false;

  /** Immersive layout: corner globe + dedicated fullscreen embed (sidebar unmounted). */
  focusMode = false;
  /** Full-viewport Focus player — separate iframe from the sidebar. */
  focusStreamEmbedUrl: SafeResourceUrl | null = null;

  selectedStream: GlobeStreamPoint | null = null;
  selectedRadio: GlobeRadioSelection | null = null;
  /** Streams from the globe refresh — used for sidebar browse/search. */
  allStreams: GlobeStreamPoint[] = [];
  /** Opened the sidebar via the search control without picking a stream/radio yet. */
  private sidebarExplicitOpen = false;
  /** Set when sidebar begins closing — morphs search control to magnifier before slide ends. */
  private panelCloseAnimationStarted = false;
  /** True while dragging the sidebar width — globe width must not ease */
  sidebarPanelResizing = false;
  /** Pixels reserved on the right for the fixed sidebar; drives globe host width */
  @HostBinding('style.--sidebar-inset.px')
  sidebarInsetPx = 0;

  @HostBinding('class.app-root--focus-mode')
  get focusModeHostClass(): boolean {
    return this.focusMode;
  }
  /** From `?stream=` on first load; globe selects + focuses after streams load */
  initialStreamQuery: string | null = null;
  initialRadioQuery: string | null = null;

  get sidebarOpen(): boolean {
    return (
      this.selectedStream !== null || this.selectedRadio !== null || this.sidebarExplicitOpen
    );
  }

  /** X vs magnifier: updates on close *start*, not when the panel unmounts. */
  get searchLaunchShowsClose(): boolean {
    return this.sidebarOpen && !this.panelCloseAnimationStarted;
  }

  openStreamSearchSidebar(): void {
    this.sidebarExplicitOpen = true;
    this.panelCloseAnimationStarted = false;
    this.sidebarInsetPx = 640;
  }

  toggleFocusMode(): void {
    if (this.focusModeTransitionOverlay) {
      return;
    }

    this.focusModeTransitionOverlay = true;
    this.cdr.detectChanges();

    const runToggle = (): void => {
      this.focusMode = !this.focusMode;
      if (!this.focusMode) {
        this.focusEmbedPomodoroAutoplayReloadUsed = false;
      }
      if (this.focusMode) {
        this.panelCloseAnimationStarted = false;
        if (this.selectedStream) {
          this.sidebarInsetPx = 0;
        }
      } else if (this.sidebarOpen) {
        this.sidebarInsetPx = 640;
      }
      this.refreshFocusStreamEmbed();
      this.syncUrlQueryParams();
      this.cdr.detectChanges();

      const ms = this.focusTransitionDurationMs();
      if (this.focusTransitionClearId !== null) {
        clearTimeout(this.focusTransitionClearId);
      }
      this.focusTransitionClearId = setTimeout(() => {
        this.focusModeTransitionOverlay = false;
        this.focusTransitionClearId = null;
        this.cdr.detectChanges();
      }, ms);
    };

    queueMicrotask(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          runToggle();
        });
      });
    });
  }

  private focusTransitionDurationMs(): number {
    if (typeof matchMedia === 'undefined') {
      return FOCUS_MODE_TRANSITION_MS;
    }
    return matchMedia('(prefers-reduced-motion: reduce)').matches
      ? FOCUS_MODE_TRANSITION_MS_REDUCED
      : FOCUS_MODE_TRANSITION_MS;
  }

  onSearchToggleClick(): void {
    if (this.sidebarOpen) {
      /* Same tick as click — morph before sidebar slide; CD so the template isn’t one frame late */
      this.panelCloseAnimationStarted = true;
      this.cdr.detectChanges();
      this.streamSidebar?.onCloseClick();
    } else {
      this.openStreamSearchSidebar();
    }
  }

  onStreamsCatalog(streams: GlobeStreamPoint[]): void {
    this.allStreams = streams;
    if (this.focusMode && !this.selectedStream) {
      this.refreshFocusStreamEmbed();
    }
  }

  ngOnInit(): void {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    const rawStream = u.searchParams.get('stream');
    const rawRadio = u.searchParams.get('radio');
    this.initialStreamQuery = rawStream?.trim() ? rawStream.trim() : null;
    this.initialRadioQuery = rawRadio?.trim() ? rawRadio.trim() : null;
    this.focusMode = parseFocusQueryParam(u.searchParams.get('focus'));
    if (this.focusMode) {
      this.focusEmbedColdStartMutedAutoplay = true;
      this.panelCloseAnimationStarted = false;
      if (this.selectedStream) {
        this.sidebarInsetPx = 0;
      }
    }
    queueMicrotask(() => this.refreshFocusStreamEmbed());
  }

  onStreamSelected(stream: GlobeStreamPoint): void {
    this.selectedStream = stream;
    this.focusEmbedPomodoroAutoplayReloadUsed = false;
    this.panelCloseAnimationStarted = false;
    this.sidebarInsetPx =
      this.focusMode && this.selectedStream ? 0 : 640;
    this.refreshFocusStreamEmbed();
    this.syncUrlQueryParams();
  }

  onRadioSelected(sel: GlobeRadioSelection): void {
    this.selectedRadio = sel;
    this.panelCloseAnimationStarted = false;
    this.sidebarInsetPx = 640;
    this.syncUrlQueryParams();
  }

  /** Start of close animation: globe expands while panel slides off */
  onSidebarClosing(): void {
    this.panelCloseAnimationStarted = true;
    this.sidebarInsetPx = 0;
  }

  onSidebarClosed(): void {
    this.selectedStream = null;
    this.selectedRadio = null;
    this.sidebarExplicitOpen = false;
    this.panelCloseAnimationStarted = false;
    this.focusStreamEmbedUrl = null;
    this.syncUrlQueryParams();
  }

  onSidebarLayoutWidth(px: number): void {
    this.sidebarInsetPx = Math.max(0, Math.round(px));
  }

  /**
   * Pomodoro Start runs in a user gesture — reload the focus embed unmuted with a fresh URL so
   * autoplay succeeds (cold `?focus=` loads often block iframe autoplay until activation).
   */
  onFocusEmbedAutoplayAfterPomodoroStart(): void {
    if (
      !this.focusMode ||
      !this.selectedStream ||
      this.focusEmbedPomodoroAutoplayReloadUsed
    ) {
      return;
    }
    this.focusEmbedPomodoroAutoplayReloadUsed = true;
    const raw = buildStreamEmbedUrl(this.selectedStream.channelLogin, {
      preferMutedAutoplay: false,
      reloadNonce: Date.now(),
    });
    this.focusStreamEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(raw);
  }

  private refreshFocusStreamEmbed(): void {
    if (!this.focusMode) {
      this.focusStreamEmbedUrl = null;
      return;
    }
    if (!this.selectedStream) {
      this.applyFocusFallbackStreamIfNeeded();
    }
    if (!this.selectedStream) {
      this.focusStreamEmbedUrl = null;
      return;
    }
    const preferMuted = this.focusEmbedColdStartMutedAutoplay;
    const raw = buildStreamEmbedUrl(this.selectedStream.channelLogin, {
      preferMutedAutoplay: preferMuted,
    });
    if (this.focusEmbedColdStartMutedAutoplay) {
      this.focusEmbedColdStartMutedAutoplay = false;
    }
    this.focusStreamEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(raw);
  }

  /** Picks first matching catalog stream from {@link FOCUS_FALLBACK_STREAM_KEYS} (see Shinjuku first). */
  private applyFocusFallbackStreamIfNeeded(): void {
    if (this.selectedStream || this.allStreams.length === 0) {
      return;
    }
    for (const key of FOCUS_FALLBACK_STREAM_KEYS) {
      const want = key.toLowerCase();
      const hit = this.allStreams.find(
        (s) => s.channelLogin.toLowerCase() === want,
      );
      if (hit) {
        this.onStreamSelected(hit);
        return;
      }
    }
  }

  get focusStreamIframeTitle(): string {
    const p = (this.selectedStream?.platform ?? 'twitch').toLowerCase();
    if (p === 'youtube') return 'YouTube player';
    if (p === 'kick') return 'Kick player';
    return 'Twitch player';
  }

  private syncUrlQueryParams(): void {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    if (this.selectedStream?.channelLogin) {
      u.searchParams.set('stream', this.selectedStream.channelLogin);
    } else {
      u.searchParams.delete('stream');
    }
    if (this.selectedRadio?.station.stationuuid) {
      u.searchParams.set('radio', this.selectedRadio.station.stationuuid);
    } else {
      u.searchParams.delete('radio');
    }
    if (this.focusMode) {
      u.searchParams.set('focus', '1');
    } else {
      u.searchParams.delete('focus');
    }
    window.history.replaceState(window.history.state, '', u.toString());
  }
}

/** True for `focus`, `focus=1`, `focus=true`, `focus=` (empty), etc.; false for `0` / `false` / omit. */
function parseFocusQueryParam(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on') {
    return true;
  }
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') {
    return false;
  }
  /* Unknown values (e.g. typos) default off so sharing links stays predictable */
  return false;
}
