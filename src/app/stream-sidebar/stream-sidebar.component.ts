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
  inject,
} from '@angular/core';
import { DecimalPipe, NgClass, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { PomodoroTimerService } from '../pomodoro-timer.service';
import type { GlobeRadioSelection } from '../radio.models';
import { RadioBrowserService } from '../radio-browser.service';
import type { GlobeStreamPoint } from '../stream.models';

@Component({
  selector: 'app-stream-sidebar',
  standalone: true,
  imports: [DecimalPipe, FormsModule, NgClass, NgIf],
  templateUrl: './stream-sidebar.component.html',
  styleUrl: './stream-sidebar.component.css',
})
export class StreamSidebarComponent implements AfterViewInit, OnChanges, OnDestroy {
  private static readonly slideMs = 380;

  readonly pomodoro = inject(PomodoroTimerService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly radioBrowser = inject(RadioBrowserService);

  @Input() stream: GlobeStreamPoint | null = null;
  @Input() radioSelection: GlobeRadioSelection | null = null;
  @Output() closing = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();
  @Output() resizeActiveChange = new EventEmitter<boolean>();
  @Output() layoutWidthPxChange = new EventEmitter<number>();

  get streamPlatform(): string {
    return (this.stream?.platform ?? 'twitch').toLowerCase();
  }

  get isYoutubeStream(): boolean {
    return this.streamPlatform === 'youtube';
  }

  get isKickStream(): boolean {
    return this.streamPlatform === 'kick';
  }

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

  get radioDockSummary(): string {
    if (!this.radioSelection) return 'No station';
    const n = this.radioSelection.station.name;
    return n.length > 38 ? `${n.slice(0, 36)}…` : n;
  }

  @ViewChild('panelRef', { read: ElementRef })
  panelRef?: ElementRef<HTMLElement>;

  @ViewChild('radioAudio') radioAudioRef?: ElementRef<HTMLAudioElement>;

  safePlayerUrl: SafeResourceUrl | null = null;
  /** Stream URL only — no audio samples are stored in app memory; buffering is the browser’s `<audio>`. */
  radioAudioUrl: string | null = null;
  radioResolveFailed = false;
  panelWidthPx: number | null = 640;

  private resizing = false;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private layoutEmitRaf = 0;
  panelOpen = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  pomodoroSectionExpanded = false;
  radioSectionExpanded = false;

  /** Dedupe canplay + loadeddata double fire per src. */
  private radioAutoplayUrl: string | null = null;

  ngAfterViewInit(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.panelOpen = true;
      });
    });
    queueMicrotask(() => this.emitLayoutWidth());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['stream']) {
      if (this.stream) {
        this.safePlayerUrl = this.buildPlayerUrl(this.stream.channelLogin);
      } else {
        this.safePlayerUrl = null;
      }
    }
    if (changes['radioSelection']) {
      if (!this.radioSelection) {
        this.radioAudioUrl = null;
        this.radioResolveFailed = false;
        this.radioSectionExpanded = false;
        this.radioAutoplayUrl = null;
      } else {
        this.radioAudioUrl = this.radioSelection.playUrl ?? null;
        this.radioResolveFailed = false;
        this.radioSectionExpanded = true;
        this.radioAutoplayUrl = null;
        void this.ensureRadioPlayUrl();
        if (this.radioAudioUrl) {
          this.scheduleRadioAutoplay();
        }
      }
    }
    if (changes['stream'] || changes['radioSelection']) {
      queueMicrotask(() => this.emitLayoutWidth());
    }
  }

  toggleRadioSection(): void {
    this.radioSectionExpanded = !this.radioSectionExpanded;
    if (this.radioSectionExpanded && this.radioSelection && !this.radioAudioUrl) {
      void this.ensureRadioPlayUrl();
    }
    if (this.radioSectionExpanded && this.radioAudioUrl) {
      this.radioAutoplayUrl = null;
      this.scheduleRadioAutoplay();
    }
  }

  private async ensureRadioPlayUrl(): Promise<void> {
    const st = this.radioSelection?.station;
    if (!st) return;
    if (this.radioAudioUrl) return;
    const url = await firstValueFrom(
      this.radioBrowser.notifyStationClick(st.stationuuid),
    );
    this.radioAudioUrl = url;
    this.radioResolveFailed = !url;
    this.radioAutoplayUrl = null;
    if (url) {
      this.scheduleRadioAutoplay();
    }
  }

  /** After globe click / URL resolve; double rAF waits for `@if` to attach `ViewChild`. */
  private scheduleRadioAutoplay(): void {
    const tryPlay = (): void => {
      const el = this.radioAudioRef?.nativeElement;
      if (!el || !this.radioAudioUrl) return;
      void el.play().catch(() => {
        /* Autoplay may be blocked; `onRadioAudioReady` retries after decode. */
      });
    };
    queueMicrotask(() => {
      requestAnimationFrame(() => requestAnimationFrame(tryPlay));
    });
  }

  onRadioAudioReady(): void {
    const el = this.radioAudioRef?.nativeElement;
    const url = this.radioAudioUrl;
    if (!el || !url) return;
    if (this.radioAutoplayUrl === url) return;
    this.radioAutoplayUrl = url;
    void el.play().catch(() => {});
  }

  /**
   * If the stream exposes `seekable` ranges (time-shifted web radio), clamp seeks so playback
   * cannot sit more than `environment.radioPlaybackMaxSeekBackSeconds` behind the range end.
   * Many live-only streams have empty `seekable` — then this is a no-op.
   */
  onRadioSeekClamp(): void {
    const maxBack = environment.radioPlaybackMaxSeekBackSeconds;
    if (maxBack <= 0) return;
    const el = this.radioAudioRef?.nativeElement;
    if (!el || el.seekable.length === 0) return;
    try {
      const i = el.seekable.length - 1;
      const rangeEnd = el.seekable.end(i);
      const rangeStart = el.seekable.start(i);
      if (!Number.isFinite(rangeEnd)) return;
      const minAllowed = Math.max(rangeStart, rangeEnd - maxBack);
      if (el.currentTime < minAllowed) {
        el.currentTime = minAllowed;
      }
    } catch {
      /* Some streams throw when querying seekable while not ready */
    }
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

    const delta = this.resizeStartX - ev.clientX;
    const next = this.resizeStartWidth + delta;
    const gutter = 12;
    const max = Math.max(gutter + 160, window.innerWidth - gutter);
    const minCandidate = Math.min(520, window.innerWidth);
    const min = Math.min(minCandidate, max);
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

  togglePomodoroSection(): void {
    this.pomodoroSectionExpanded = !this.pomodoroSectionExpanded;
  }
}
