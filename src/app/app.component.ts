import { ChangeDetectorRef, Component, HostBinding, OnInit, ViewChild } from '@angular/core';
import { GlobeViewComponent } from './globe-view/globe-view.component';
import type { GlobeRadioSelection } from './radio.models';
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

  constructor(private readonly cdr: ChangeDetectorRef) {}

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
  }

  onStreamSelected(stream: GlobeStreamPoint): void {
    this.selectedStream = stream;
    this.panelCloseAnimationStarted = false;
    this.sidebarInsetPx = 640;
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
    this.syncUrlQueryParams();
  }

  onSidebarLayoutWidth(px: number): void {
    this.sidebarInsetPx = Math.max(0, Math.round(px));
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
    window.history.replaceState(window.history.state, '', u.toString());
  }
}
