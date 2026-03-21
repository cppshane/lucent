import { Component, HostBinding, OnInit } from '@angular/core';
import { GlobeViewComponent } from './globe-view/globe-view.component';
import type { GlobeStreamPoint } from './stream.models';
import { StreamSidebarComponent } from './stream-sidebar/stream-sidebar.component';

@Component({
  selector: 'app-root',
  imports: [GlobeViewComponent, StreamSidebarComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  selectedStream: GlobeStreamPoint | null = null;
  /** True while dragging the sidebar width — globe width must not ease */
  sidebarPanelResizing = false;
  /** Pixels reserved on the right for the fixed sidebar; drives globe host width */
  @HostBinding('style.--sidebar-inset.px')
  sidebarInsetPx = 0;
  /** From `?stream=` on first load; globe selects + focuses after streams load */
  initialStreamQuery: string | null = null;

  ngOnInit(): void {
    if (typeof window === 'undefined') return;
    const raw = new URL(window.location.href).searchParams.get('stream');
    this.initialStreamQuery = raw?.trim() ? raw.trim() : null;
  }

  onStreamSelected(stream: GlobeStreamPoint): void {
    this.selectedStream = stream;
    this.sidebarInsetPx = 640;
    this.syncStreamQueryParam();
  }

  /** Start of close animation: globe expands while panel slides off */
  onSidebarClosing(): void {
    this.sidebarInsetPx = 0;
  }

  onSidebarClosed(): void {
    this.selectedStream = null;
    this.syncStreamQueryParam();
  }

  onSidebarLayoutWidth(px: number): void {
    this.sidebarInsetPx = Math.max(0, Math.round(px));
  }

  private syncStreamQueryParam(): void {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    if (this.selectedStream?.channelLogin) {
      u.searchParams.set('stream', this.selectedStream.channelLogin);
    } else {
      u.searchParams.delete('stream');
    }
    window.history.replaceState(window.history.state, '', u.toString());
  }
}
