import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { DecimalPipe, NgIf } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import type { GlobeStreamPoint } from '../stream.models';

@Component({
  selector: 'app-stream-sidebar',
  standalone: true,
  imports: [DecimalPipe, NgIf],
  templateUrl: './stream-sidebar.component.html',
  styleUrl: './stream-sidebar.component.css',
})
export class StreamSidebarComponent implements AfterViewInit, OnChanges, OnDestroy {
  /** Matches .panel transition (ms) — keep in sync with stream-sidebar.component.css */
  private static readonly slideMs = 380;

  @Input({ required: true }) stream!: GlobeStreamPoint;
  @Output() closing = new EventEmitter<void>();

  get streamPlatform(): string {
    return (this.stream?.platform ?? 'twitch').toLowerCase();
  }

  get isYoutubeStream(): boolean {
    return this.streamPlatform === 'youtube';
  }

  get isKickStream(): boolean {
    return this.streamPlatform === 'kick';
  }

  /** Shown on the external link; `.external` applies `text-transform: uppercase`. */
  get openOnPlatformLabel(): string {
    if (this.isYoutubeStream) return 'Open on YouTube';
    if (this.isKickStream) return 'Open on Kick';
    return 'Open on Twitch';
  }

  get embedPlayerTitle(): string {
    if (this.isYoutubeStream) return 'YouTube player';
    if (this.isKickStream) return 'Kick player';
    return 'Twitch player';
  }
  @Output() closed = new EventEmitter<void>();
  @Output() resizeActiveChange = new EventEmitter<boolean>();
  @Output() layoutWidthPxChange = new EventEmitter<number>();

  @ViewChild('panelRef', { read: ElementRef })
  panelRef?: ElementRef<HTMLElement>;

  safePlayerUrl: SafeResourceUrl | null = null;
  /** Default open width; user drag updates this */
  panelWidthPx: number | null = 640;

  private resizing = false;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private layoutEmitRaf = 0;
  /** Slide-in from right after mount */
  panelOpen = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sanitizer: DomSanitizer) {}

  ngAfterViewInit(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.panelOpen = true;
      });
    });
    queueMicrotask(() => this.emitLayoutWidth());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['stream'] || !this.stream) return;
    this.safePlayerUrl = this.stream.channelLogin
      ? this.buildPlayerUrl(this.stream.channelLogin)
      : null;
    queueMicrotask(() => this.emitLayoutWidth());
  }

  private buildPlayerUrl(channel: string): SafeResourceUrl {
    if (channel.startsWith('yt-')) {
      const id = channel.slice(3);
      const url = `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1`;
      return this.sanitizer.bypassSecurityTrustResourceUrl(url);
    }

    if (channel.startsWith('kick-')) {
      const slug = channel.slice(5);
      const url = `https://player.kick.com/${encodeURIComponent(slug)}?autoplay=true`;
      return this.sanitizer.bypassSecurityTrustResourceUrl(url);
    }

    const params = new URLSearchParams();
    params.set('channel', channel);
    params.set('muted', 'false');
    const parents = new Set<string>([
      typeof window !== 'undefined' ? window.location.hostname : 'localhost',
      'localhost',
      '127.0.0.1',
    ]);
    parents.forEach((p) => params.append('parent', p));
    const url = `https://player.twitch.tv/?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  onCloseClick(): void {
    if (this.closeTimer !== null) return;
    this.closing.emit();
    this.panelOpen = false;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.closed.emit();
    }, StreamSidebarComponent.slideMs);
  }

  onResizeMouseDown(ev: MouseEvent): void {
    ev.preventDefault();
    this.resizing = true;
    this.resizeActiveChange.emit(true);
    this.resizeStartX = ev.clientX;
    this.resizeStartWidth =
      this.panelWidthPx ??
      (ev.currentTarget as HTMLElement).closest('.panel')?.getBoundingClientRect().width ??
      640;

    window.addEventListener('mousemove', this.onResizeMouseMove);
    window.addEventListener('mouseup', this.onResizeMouseUp);
  }

  ngOnDestroy(): void {
    window.removeEventListener('mousemove', this.onResizeMouseMove);
    window.removeEventListener('mouseup', this.onResizeMouseUp);
    if (this.layoutEmitRaf) cancelAnimationFrame(this.layoutEmitRaf);
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.resizing) this.resizeActiveChange.emit(false);
  }

  private readonly onResizeMouseMove = (ev: MouseEvent): void => {
    if (!this.resizing) return;

    // Right-anchored panel: dragging left edge left increases width.
    const delta = this.resizeStartX - ev.clientX;
    const next = this.resizeStartWidth + delta;
    const min = Math.min(520, window.innerWidth);
    const max = Math.min(980, Math.floor(window.innerWidth * 0.82));
    this.panelWidthPx = Math.max(min, Math.min(max, next));
    this.scheduleLayoutWidthEmit();
  };

  private readonly onResizeMouseUp = (): void => {
    if (!this.resizing) return;
    this.resizing = false;
    this.resizeActiveChange.emit(false);
    window.removeEventListener('mousemove', this.onResizeMouseMove);
    window.removeEventListener('mouseup', this.onResizeMouseUp);
    if (this.layoutEmitRaf) {
      cancelAnimationFrame(this.layoutEmitRaf);
      this.layoutEmitRaf = 0;
    }
    this.emitLayoutWidth();
  };

  private scheduleLayoutWidthEmit(): void {
    if (this.layoutEmitRaf) return;
    this.layoutEmitRaf = requestAnimationFrame(() => {
      this.layoutEmitRaf = 0;
      this.emitLayoutWidth();
    });
  }

  private emitLayoutWidth(): void {
    const el = this.panelRef?.nativeElement;
    if (!el) return;
    const w = Math.round(el.getBoundingClientRect().width);
    if (w > 0) this.layoutWidthPxChange.emit(w);
  }
}
