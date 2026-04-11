import {
  Component,
  NgZone,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

const LS_SETTINGS = 'lucent-focus-pomodoro-settings';
const LS_TASKS = 'lucent-focus-pomodoro-tasks';

/** Max stroke length (path units) for the 270° arc — matches track `750` of `pathLength` 1000 */
const ARC_UNITS = 750;
/** Gap in dasharray so the pattern does not repeat on the circle */
const DASH_GAP_TAIL = 2000;

export interface PomodoroTask {
  id: string;
  title: string;
  cycles: number;
}

@Component({
  selector: 'app-focus-pomodoro',
  templateUrl: './focus-pomodoro.component.html',
  styleUrl: './focus-pomodoro.component.css',
  imports: [FormsModule],
})
export class FocusPomodoroComponent implements OnInit, OnDestroy {
  private readonly ngZone = inject(NgZone);

  readonly phase = signal<'work' | 'break'>('work');
  readonly workSeconds = signal(25 * 60);
  readonly breakSeconds = signal(5 * 60);

  readonly totalSeconds = computed(() =>
    this.phase() === 'work' ? this.workSeconds() : this.breakSeconds(),
  );

  readonly remainingSeconds = signal(25 * 60);
  readonly isRunning = signal(false);

  readonly settingsOpen = signal(false);
  readonly tasksOpen = signal(false);

  readonly tasks = signal<PomodoroTask[]>([]);
  readonly taskRoundIndex = signal(0);

  newTaskTitle = '';
  newTaskCycles = 1;
  draftWorkMin = 25;
  draftBreakMin = 5;

  readonly gradientId = `pomoGrad-${Math.random().toString(36).slice(2, 9)}`;

  readonly currentTask = computed(() => {
    const list = this.tasks();
    if (list.length === 0) return null;
    const i = this.taskRoundIndex() % list.length;
    return list[i] ?? null;
  });

  readonly taskLine = computed(() => {
    if (this.phase() !== 'work') return null;
    const t = this.currentTask();
    if (!t) return null;
    return t.title;
  });

  readonly timeDisplay = computed(() => {
    const s = Math.max(0, this.remainingSeconds());
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
  });

  /**
   * Shrinking arc: first dash length = fraction of 270° arc remaining (not stroke-dashoffset,
   * which slides the pattern and looks like rotation).
   */
  readonly arcProgressDash = computed(() => {
    const total = this.totalSeconds();
    if (total <= 0) return `0 ${DASH_GAP_TAIL}`;
    const frac = Math.max(
      0,
      Math.min(1, this.remainingSeconds() / total),
    );
    const vis = ARC_UNITS * frac;
    return `${vis} ${DASH_GAP_TAIL}`;
  });

  private tickId: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.loadPersisted();
    this.ngZone.runOutsideAngular(() => {
      this.tickId = setInterval(() => {
        this.ngZone.run(() => this.tick());
      }, 1000);
    });
  }

  ngOnDestroy(): void {
    if (this.tickId !== null) {
      clearInterval(this.tickId);
      this.tickId = null;
    }
  }

  private loadPersisted(): void {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) {
        const o = JSON.parse(raw) as { workMin?: number; breakMin?: number };
        if (typeof o.workMin === 'number' && o.workMin > 0) {
          this.workSeconds.set(Math.round(o.workMin * 60));
        }
        if (typeof o.breakMin === 'number' && o.breakMin >= 0) {
          this.breakSeconds.set(Math.round(o.breakMin * 60));
        }
      }
      const tr = localStorage.getItem(LS_TASKS);
      if (tr) {
        const arr = JSON.parse(tr) as PomodoroTask[];
        if (Array.isArray(arr)) {
          this.tasks.set(
            arr.filter(
              (t) =>
                t &&
                typeof t.id === 'string' &&
                typeof t.title === 'string' &&
                typeof t.cycles === 'number',
            ),
          );
        }
      }
    } catch {
      /* ignore */
    }
    this.phase.set('work');
    this.remainingSeconds.set(this.workSeconds());
    this.draftWorkMin = this.workSeconds() / 60;
    this.draftBreakMin = this.breakSeconds() / 60;
  }

  private persistSettings(): void {
    try {
      localStorage.setItem(
        LS_SETTINGS,
        JSON.stringify({
          workMin: this.workSeconds() / 60,
          breakMin: this.breakSeconds() / 60,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  private persistTasks(): void {
    try {
      localStorage.setItem(LS_TASKS, JSON.stringify(this.tasks()));
    } catch {
      /* ignore */
    }
  }

  private tick(): void {
    if (!this.isRunning()) return;
    const r = this.remainingSeconds();
    if (r <= 0) {
      this.onPhaseComplete();
      return;
    }
    this.remainingSeconds.set(r - 1);
  }

  private onPhaseComplete(): void {
    const done = this.phase();
    this.notifyPhaseDone(done);

    if (done === 'work') {
      this.taskRoundIndex.update((i) => i + 1);
      if (this.breakSeconds() <= 0) {
        this.phase.set('work');
        this.remainingSeconds.set(this.workSeconds());
        this.isRunning.set(true);
        return;
      }
      this.phase.set('break');
      this.remainingSeconds.set(this.breakSeconds());
      this.isRunning.set(true);
    } else {
      this.phase.set('work');
      this.remainingSeconds.set(this.workSeconds());
      this.isRunning.set(true);
    }
  }

  private notifyPhaseDone(phase: 'work' | 'break'): void {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      const body =
        phase === 'work'
          ? 'Focus block complete. Time for a break.'
          : 'Break complete. Ready for the next focus block.';
      new Notification('lucent.earth · Focus', {
        body,
        tag: 'lucent-pomodoro',
      });
    } catch {
      /* ignore */
    }
  }

  private requestNotifyPermissionIfNeeded(): void {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    void Notification.requestPermission();
  }

  toggleRunning(): void {
    if (this.remainingSeconds() <= 0) {
      this.resetPhase();
      return;
    }
    const next = !this.isRunning();
    if (next) {
      this.requestNotifyPermissionIfNeeded();
    }
    this.isRunning.set(next);
  }

  resetPhase(): void {
    const t =
      this.phase() === 'work' ? this.workSeconds() : this.breakSeconds();
    this.remainingSeconds.set(t);
    this.isRunning.set(false);
  }

  applySettings(): void {
    const w = Math.max(1, Math.min(180, this.draftWorkMin));
    const b = Math.max(0, Math.min(60, this.draftBreakMin));
    this.workSeconds.set(Math.round(w * 60));
    this.breakSeconds.set(Math.round(b * 60));
    this.persistSettings();
    this.phase.set('work');
    this.remainingSeconds.set(this.workSeconds());
    this.isRunning.set(false);
    this.settingsOpen.set(false);
  }

  toggleSettings(): void {
    const next = !this.settingsOpen();
    if (next) {
      this.draftWorkMin = this.workSeconds() / 60;
      this.draftBreakMin = this.breakSeconds() / 60;
      this.tasksOpen.set(false);
    }
    this.settingsOpen.set(next);
  }

  toggleTasks(): void {
    const next = !this.tasksOpen();
    if (next) this.settingsOpen.set(false);
    this.tasksOpen.set(next);
  }

  addTask(): void {
    const title = this.newTaskTitle.trim();
    if (!title) return;
    const cycles = Math.max(1, Math.floor(Number(this.newTaskCycles)) || 1);
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `t-${Date.now()}`;
    this.tasks.update((list) => [...list, { id, title, cycles }]);
    this.newTaskTitle = '';
    this.newTaskCycles = 1;
    this.persistTasks();
  }

  removeTask(id: string): void {
    this.tasks.update((list) => list.filter((t) => t.id !== id));
    this.persistTasks();
  }

  readonly ringRotateDeg = 112.5;
}
