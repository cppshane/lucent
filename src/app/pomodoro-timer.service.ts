import { computed, Injectable, signal } from '@angular/core';

export type PomodoroPhase = 'idle' | 'focus' | 'short_break';

@Injectable({ providedIn: 'root' })
export class PomodoroTimerService {
  readonly phase = signal<PomodoroPhase>('idle');
  readonly remainingSec = signal(0);
  readonly phaseTotalSec = signal(0);
  readonly running = signal(false);
  readonly workMin = signal(25);
  readonly breakMin = signal(5);

  readonly phaseLabel = computed(() => {
    switch (this.phase()) {
      case 'focus':
        return 'Focus';
      case 'short_break':
        return 'Break';
      default:
        return 'Ready';
    }
  });

  readonly timeLabel = computed(() => {
    if (this.phase() === 'idle' && !this.running()) {
      const m = clampFocusMin(this.workMin());
      return `${m}:00`;
    }
    const s = Math.max(0, this.remainingSec());
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  });

  readonly progressPercent = computed(() => {
    const total = this.phaseTotalSec();
    if (total <= 0) return 0;
    const rem = Math.max(0, this.remainingSec());
    const elapsed = total - rem;
    return Math.min(100, Math.max(0, (100 * elapsed) / total));
  });

  readonly configLocked = computed(
    () => this.running() || this.phase() !== 'idle',
  );

  readonly barVisible = computed(
    () => this.phase() !== 'idle' || this.running(),
  );

  private endsAtMs = 0;
  private tickId: ReturnType<typeof setInterval> | null = null;

  updateWorkMin(raw: number | string): void {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
    this.workMin.set(clampFocusMin(Number.isFinite(n) ? n : this.workMin()));
  }

  updateBreakMin(raw: number | string): void {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
    this.breakMin.set(clampBreakMin(Number.isFinite(n) ? n : this.breakMin()));
  }

  startOrResume(): void {
    if (this.running()) return;
    if (this.phase() === 'idle') {
      this.beginPhase('focus', clampFocusMin(this.workMin()) * 60);
    } else {
      let left = Math.max(0, Math.ceil((this.endsAtMs - Date.now()) / 1000));
      if (left <= 0 && this.remainingSec() > 0) left = this.remainingSec();
      if (left <= 0) {
        this.advanceAfterZero();
        return;
      }
      this.endsAtMs = Date.now() + left * 1000;
      this.remainingSec.set(left);
    }
    this.running.set(true);
    this.startTick();
  }

  pause(): void {
    if (!this.running()) return;
    this.remainingSec.set(
      Math.max(0, Math.ceil((this.endsAtMs - Date.now()) / 1000)),
    );
    this.stopTick();
    this.running.set(false);
  }

  reset(): void {
    this.stopTick();
    this.running.set(false);
    this.phase.set('idle');
    this.remainingSec.set(0);
    this.endsAtMs = 0;
    this.phaseTotalSec.set(0);
  }

  private startTick(): void {
    this.stopTick();
    this.tickId = window.setInterval(() => this.onTick(), 500);
    this.onTick();
  }

  private stopTick(): void {
    if (this.tickId !== null) {
      clearInterval(this.tickId);
      this.tickId = null;
    }
  }

  private onTick(): void {
    if (!this.running()) return;
    const left = Math.max(0, Math.ceil((this.endsAtMs - Date.now()) / 1000));
    this.remainingSec.set(left);
    if (left <= 0) {
      const ended = this.phase();
      this.playPhaseChime(ended);
      this.advanceAfterZero();
    }
  }

  private advanceAfterZero(): void {
    const p = this.phase();
    if (p === 'focus') {
      this.beginPhase('short_break', clampBreakMin(this.breakMin()) * 60);
    } else if (p === 'short_break') {
      this.beginPhase('focus', clampFocusMin(this.workMin()) * 60);
    } else {
      this.reset();
      return;
    }
  }

  private beginPhase(phase: PomodoroPhase, seconds: number): void {
    const s = Math.max(1, Math.floor(seconds));
    this.phase.set(phase);
    this.phaseTotalSec.set(s);
    this.remainingSec.set(s);
    this.endsAtMs = Date.now() + s * 1000;
  }

  /**
   * Short arpeggio: end of focus = brighter upward triad; end of break = warmer return-to-work.
   */
  private playPhaseChime(endedPhase: PomodoroPhase): void {
    if (endedPhase !== 'focus' && endedPhase !== 'short_break') return;
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return;

      const ctx = new AC();
      const master = ctx.createGain();
      master.connect(ctx.destination);

      const focusEnded = endedPhase === 'focus';
      /** Hz — three quick bells */
      const freqs = focusEnded
        ? [784.0, 987.77, 1174.66]
        : [392.0, 493.88, 587.33];

      const spacing = 0.095;
      const attack = 0.018;
      const sustain = 0.38;
      const peak = focusEnded ? 0.2 : 0.16;

      let lastStop = ctx.currentTime;
      freqs.forEach((freq, i) => {
        const t0 = ctx.currentTime + i * spacing;
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t0);

        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(freq * 2.01, t0);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + attack);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + sustain);

        osc.connect(g);
        osc2.connect(g);
        g.connect(master);
        osc.start(t0);
        osc2.start(t0);
        osc.stop(t0 + sustain + 0.05);
        osc2.stop(t0 + sustain + 0.05);
        lastStop = Math.max(lastStop, t0 + sustain + 0.05);
      });

      master.gain.setValueAtTime(0.95, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(0.001, lastStop + 0.12);

      window.setTimeout(() => {
        try {
          ctx.close();
        } catch {
          /* ignore */
        }
      }, Math.ceil((lastStop - ctx.currentTime + 0.2) * 1000));
    } catch {
      /* ignore */
    }
  }
}

function clampFocusMin(m: number): number {
  if (!Number.isFinite(m) || m < 1) return 1;
  if (m > 180) return 180;
  return Math.floor(m);
}

function clampBreakMin(m: number): number {
  if (!Number.isFinite(m) || m < 1) return 1;
  if (m > 60) return 60;
  return Math.floor(m);
}
