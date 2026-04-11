import { ChangeDetectorRef, Component, HostBinding, OnInit, ViewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { GlobeViewComponent } from './globe-view/globe-view.component';
import type { GlobeRadioSelection } from './radio.models';
import { buildStreamEmbedUrl } from './stream-embed-url';
import type { GlobeStreamPoint } from './stream.models';
import { StreamSidebarComponent } from './stream-sidebar/stream-sidebar.component';

@Component({
  selector: 'app-root',
  imports: [GlobeViewComponent, StreamSidebarComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  @ViewChild(StreamSidebarComponent) private streamSidebar?: StreamSidebarComponent;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly sanitizer: DomSanitizer,
  ) {}

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
    this.focusMode = !this.focusMode;
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
      this.panelCloseAnimationStarted = false;
      if (this.selectedStream) {
        this.sidebarInsetPx = 0;
      }
    }
    queueMicrotask(() => this.refreshFocusStreamEmbed());
  }

  onStreamSelected(stream: GlobeStreamPoint): void {
    this.selectedStream = stream;
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

  private refreshFocusStreamEmbed(): void {
    if (!this.focusMode || !this.selectedStream) {
      this.focusStreamEmbedUrl = null;
      return;
    }
    const raw = buildStreamEmbedUrl(this.selectedStream.channelLogin);
    this.focusStreamEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(raw);
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
