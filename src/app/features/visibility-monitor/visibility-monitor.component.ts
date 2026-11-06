/**
 * @file visibility-monitor.component.ts
 * @description Dashboard empresarial de monitoreo de actividad del usuario.
 *
 * Consume el BrowserActivityFacade para mostrar en tiempo real:
 *  - Estado de visibilidad (Page Visibility API)
 *  - Estado de inactividad (idle detection)
 *  - Estado de red (online/offline + tipo de conexión)
 *  - Nivel de atención calculado
 *  - Feed unificado de los últimos 15 eventos
 *  - Métricas de sesión (duración, eventos enviados, cola pendiente)
 *
 * Estrategia de rendering:
 *  - OnPush + Angular Signals → updates quirúrgicos sin CD global.
 *  - takeUntilDestroyed → cleanup automático sin OnDestroy manual.
 *  - Intervalo de refresco de stats cada segundo (solo para el contador de duración).
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, NgClass } from '@angular/common';
import { interval } from 'rxjs';
import { tap } from 'rxjs/operators';

import { BrowserActivityFacade } from '../../core/services/browser-activity.facade';
import { ActivityState, IdleState, NetworkState } from '../../core/services/browser-activity.model';
import { VisibilitySnapshot } from '../../core/services/browser-visibility.model';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos del componente
// ─────────────────────────────────────────────────────────────────────────────

type FeedEventKind = 'visibility' | 'idle' | 'network' | 'attention';

interface FeedEntry {
  readonly id: string;
  readonly kind: FeedEventKind;
  readonly label: string;
  readonly detail: string;
  readonly icon: string;
  readonly isPositive: boolean;
  readonly timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-visibility-monitor',
  standalone: true,
  imports: [DatePipe, NgClass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dashboard">

      <!-- ══════════════════════════════════════════════
           HEADER
      ══════════════════════════════════════════════ -->
      <header class="dash-header">
        <div class="dash-brand">
          <span class="dash-logo">📡</span>
          <div>
            <h1>Activity Monitor</h1>
            <span class="dash-session">Session · {{ sessionId }}</span>
          </div>
        </div>
        <div class="dash-header-right">
          <span class="live-badge">
            <span class="live-dot"></span>LIVE
          </span>
          <span
            class="attention-badge"
            [ngClass]="attentionClass()"
          >
            {{ attentionLabel() }}
          </span>
        </div>
      </header>

      <!-- ══════════════════════════════════════════════
           STATUS PILLARS (Visibilidad · Idle · Red)
      ══════════════════════════════════════════════ -->
      <section class="pillars">

        <!-- Visibilidad -->
        <div
          class="pillar"
          [ngClass]="visibilityClass()"
        >
          <div class="pillar-icon">{{ visibilityIcon() }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Pestaña</span>
            <span class="pillar-value">
              {{ currentState()?.visibility?.isTabActive ? 'ACTIVA' : 'INACTIVA' }}
            </span>
            <span class="pillar-sub">
              {{ currentState()?.visibility?.visibilityState ?? '—' }}
            </span>
          </div>
        </div>

        <!-- Idle -->
        <div
          class="pillar"
          [ngClass]="idleClass()"
        >
          <div class="pillar-icon">{{ idleIcon() }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Usuario</span>
            <span class="pillar-value">
              {{ currentState()?.idle?.status === 'active' ? 'ACTIVO' : 'INACTIVO' }}
            </span>
            <span class="pillar-sub">
              @if (currentState()?.idle?.lastActivityEvent) {
                {{ currentState()?.idle?.lastActivityEvent }}
              } @else {
                sin actividad
              }
            </span>
          </div>
        </div>

        <!-- Red -->
        <div
          class="pillar"
          [ngClass]="networkClass()"
        >
          <div class="pillar-icon">{{ networkIcon() }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Red</span>
            <span class="pillar-value">
              {{ currentState()?.network?.isOnline ? 'ONLINE' : 'OFFLINE' }}
            </span>
            <span class="pillar-sub">
              {{ currentState()?.network?.effectiveType ?? 'desconocido' }}
            </span>
          </div>
        </div>

      </section>

      <!-- ══════════════════════════════════════════════
           SESSION STATS
      ══════════════════════════════════════════════ -->
      <section class="stats-row">
        <div class="stat">
          <span class="stat-value">{{ sessionDuration() }}</span>
          <span class="stat-label">Duración</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ feedEntries().length }}</span>
          <span class="stat-label">Eventos UI</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ queueSize() }}</span>
          <span class="stat-label">Cola pendiente</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ sentBatches() }}</span>
          <span class="stat-label">Batches enviados</span>
        </div>
      </section>

      <!-- ══════════════════════════════════════════════
           ACTIVITY FEED
      ══════════════════════════════════════════════ -->
      <section class="feed-section">
        <div class="feed-header">
          <span class="feed-title">Feed de Actividad</span>
          <span class="feed-count">{{ feedEntries().length }} / 15</span>
        </div>

        @if (feedEntries().length === 0) {
          <div class="feed-empty">
            <span>🕐</span>
            <p>Esperando eventos... Mueve el ratón, cambia de pestaña o presiona Alt+Tab.</p>
          </div>
        } @else {
          <ul class="feed-list" role="log" aria-live="polite" aria-label="Activity feed">
            @for (entry of feedEntries(); track entry.id) {
              <li class="feed-item" [ngClass]="'feed-' + entry.kind">
                <span class="fi-icon">{{ entry.icon }}</span>
                <div class="fi-body">
                  <span class="fi-label">{{ entry.label }}</span>
                  <span class="fi-detail">{{ entry.detail }}</span>
                </div>
                <span class="fi-time">
                  {{ entry.timestamp | date: 'HH:mm:ss.SSS' }}
                </span>
                <span
                  class="fi-dot"
                  [ngClass]="entry.isPositive ? 'dot--green' : 'dot--red'"
                ></span>
              </li>
            }
          </ul>
        }
      </section>

      <!-- ══════════════════════════════════════════════
           FOOTER
      ══════════════════════════════════════════════ -->
      <footer class="dash-footer">
        <span>💡 Detecta: pestaña · foco · teclado · ratón · scroll · touch · red</span>
        <span class="footer-hint">Iniciado {{ sessionStart | date: 'HH:mm:ss' }}</span>
      </footer>

    </div>
  `,
  styles: [`
    /* ── Reset y base ─────────────────────────────────────── */
    :host { display: block; font-family: 'Inter', -apple-system, sans-serif; }

    .dashboard {
      max-width: 820px;
      margin: 1.5rem auto;
      background: #0f172a;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 8px 48px rgba(0,0,0,.4);
      color: #e2e8f0;
    }

    /* ── Header ───────────────────────────────────────────── */
    .dash-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.25rem 1.5rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
    }
    .dash-brand { display: flex; align-items: center; gap: .75rem; }
    .dash-logo  { font-size: 1.75rem; }
    .dash-brand h1 { margin: 0; font-size: 1rem; font-weight: 700; color: #f1f5f9; }
    .dash-session  { font-size: .7rem; color: #64748b; font-family: monospace; }

    .dash-header-right { display: flex; align-items: center; gap: .75rem; }

    /* Live badge */
    .live-badge {
      display: flex; align-items: center; gap: .35rem;
      font-size: .7rem; font-weight: 700; letter-spacing: .08em;
      color: #4ade80; background: rgba(74,222,128,.1);
      padding: .2rem .6rem; border-radius: 999px;
      border: 1px solid rgba(74,222,128,.2);
    }
    .live-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #4ade80;
      animation: pulse 1.5s infinite;
    }

    /* Attention badge */
    .attention-badge {
      font-size: .75rem; font-weight: 700; letter-spacing: .06em;
      padding: .25rem .75rem; border-radius: 999px;
    }
    .att--full    { background: #166534; color: #4ade80; }
    .att--partial { background: #713f12; color: #fbbf24; }
    .att--none    { background: #7f1d1d; color: #f87171; }

    /* ── Pillars ──────────────────────────────────────────── */
    .pillars {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      background: #334155;
      border-bottom: 1px solid #334155;
    }

    .pillar {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1.25rem 1.5rem;
      background: #1e293b;
      transition: background .3s;
    }
    .pillar-icon { font-size: 2rem; }
    .pillar-body { display: flex; flex-direction: column; gap: .2rem; }
    .pillar-label { font-size: .65rem; text-transform: uppercase; letter-spacing: .1em; color: #64748b; }
    .pillar-value { font-size: .95rem; font-weight: 700; }
    .pillar-sub   { font-size: .7rem; color: #94a3b8; font-family: monospace; }

    /* Pillar states */
    .pillar--ok     .pillar-value { color: #4ade80; }
    .pillar--warn   .pillar-value { color: #fbbf24; }
    .pillar--danger .pillar-value { color: #f87171; }

    /* ── Stats row ────────────────────────────────────────── */
    .stats-row {
      display: flex;
      border-bottom: 1px solid #1e293b;
    }
    .stat {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: .9rem .5rem;
      border-right: 1px solid #1e293b;
      gap: .2rem;
    }
    .stat:last-child { border-right: none; }
    .stat-value { font-size: 1.3rem; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; }
    .stat-label { font-size: .65rem; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }

    /* ── Feed ─────────────────────────────────────────────── */
    .feed-section { padding: 1rem 1.25rem; }
    .feed-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: .75rem;
    }
    .feed-title { font-size: .8rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .08em; }
    .feed-count { font-size: .7rem; color: #475569; }

    .feed-empty {
      display: flex; align-items: center; gap: .75rem;
      padding: 1.25rem; border-radius: 8px;
      background: #1e293b; color: #475569; font-size: .82rem;
    }
    .feed-empty span { font-size: 1.5rem; }

    .feed-list {
      list-style: none; margin: 0; padding: 0;
      display: flex; flex-direction: column; gap: .35rem;
      max-height: 300px; overflow-y: auto;
    }
    .feed-list::-webkit-scrollbar { width: 4px; }
    .feed-list::-webkit-scrollbar-track { background: transparent; }
    .feed-list::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

    .feed-item {
      display: flex; align-items: center; gap: .6rem;
      padding: .45rem .75rem; border-radius: 6px;
      background: #1e293b;
      animation: slideIn .2s ease;
      transition: background .2s;
    }
    .feed-item:hover { background: #263548; }

    .feed-visibility { border-left: 2px solid #6366f1; }
    .feed-idle       { border-left: 2px solid #f59e0b; }
    .feed-network    { border-left: 2px solid #0ea5e9; }
    .feed-attention  { border-left: 2px solid #10b981; }

    .fi-icon   { font-size: 1rem; min-width: 1.5rem; text-align: center; }
    .fi-body   { flex: 1; display: flex; flex-direction: column; gap: .05rem; }
    .fi-label  { font-size: .78rem; font-weight: 600; color: #e2e8f0; }
    .fi-detail { font-size: .68rem; color: #64748b; font-family: monospace; }
    .fi-time   { font-size: .68rem; color: #475569; font-family: monospace; white-space: nowrap; }

    .fi-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .dot--green { background: #4ade80; }
    .dot--red   { background: #f87171; }

    /* ── Footer ───────────────────────────────────────────── */
    .dash-footer {
      display: flex; justify-content: space-between; align-items: center;
      padding: .65rem 1.25rem;
      background: #1e293b; border-top: 1px solid #334155;
      font-size: .7rem; color: #475569;
    }

    /* ── Animations ───────────────────────────────────────── */
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: .3; }
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-8px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    /* ── Responsive ───────────────────────────────────────── */
    @media (max-width: 600px) {
      .pillars { grid-template-columns: 1fr; }
      .stats-row { flex-wrap: wrap; }
      .stat { min-width: 50%; }
    }
  `],
})
export class VisibilityMonitorComponent implements OnInit {
  // ── Dependencias ─────────────────────────────────────────────────────────
  private readonly destroyRef = inject(DestroyRef);
  private readonly facade = inject(BrowserActivityFacade);

  // ── Estado del componente con Signals ─────────────────────────────────
  readonly currentState = signal<ActivityState | null>(null);
  readonly feedEntries = signal<FeedEntry[]>([]);
  readonly queueSize = signal<number>(0);
  readonly sentBatches = signal<number>(0);
  readonly sessionDuration = signal<string>('00:00:00');

  // Exponer sessionId y sessionStart al template
  readonly sessionId = this.facade.getSessionStats().sessionId;
  readonly sessionStart = this.facade.getSessionStats().startedAt;

  private static readonly MAX_FEED = 15;

  // ── Computed signals ─────────────────────────────────────────────────────
  readonly attentionLabel = computed(() => {
    const level = this.currentState()?.attentionLevel;
    return level === 'full' ? '● ATENCIÓN TOTAL'
         : level === 'partial' ? '◑ ATENCIÓN PARCIAL'
         : '○ SIN ATENCIÓN';
  });

  readonly attentionClass = computed(() => {
    const level = this.currentState()?.attentionLevel;
    return level === 'full' ? 'att--full'
         : level === 'partial' ? 'att--partial'
         : 'att--none';
  });

  // Pillar: Visibilidad
  readonly visibilityClass = computed(() => {
    const v = this.currentState()?.visibility;
    if (!v) return 'pillar--warn';
    return v.isTabActive && v.visibilityState === 'visible'
      ? 'pillar--ok' : 'pillar--danger';
  });
  readonly visibilityIcon = computed(() =>
    this.currentState()?.visibility?.isTabActive ? '👁️' : '🙈',
  );

  // Pillar: Idle
  readonly idleClass = computed(() =>
    this.currentState()?.idle?.status === 'active' ? 'pillar--ok' : 'pillar--warn',
  );
  readonly idleIcon = computed(() =>
    this.currentState()?.idle?.status === 'active' ? '⚡' : '💤',
  );

  // Pillar: Red
  readonly networkClass = computed(() =>
    this.currentState()?.network?.isOnline ? 'pillar--ok' : 'pillar--danger',
  );
  readonly networkIcon = computed(() =>
    this.currentState()?.network?.isOnline ? '🌐' : '📵',
  );

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  ngOnInit(): void {
    // 1. Suscripción al estado unificado
    this.facade.activityState$.pipe(
      tap((state) => {
        this.currentState.set(state);
        this.addFeedEntry(state);
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();

    // 2. Tamaño de la cola
    this.facade.queueSize$.pipe(
      tap((n) => this.queueSize.set(n)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();

    // 3. Refresco del contador de duración (1s)
    interval(1_000).pipe(
      tap(() => {
        const stats = this.facade.getSessionStats();
        this.sessionDuration.set(this.formatDuration(stats.durationMs));
        this.sentBatches.set(stats.sentBatches);
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  // ── Helpers privados ─────────────────────────────────────────────────────

  private addFeedEntry(state: ActivityState): void {
    const entry = this.buildFeedEntry(state);
    this.feedEntries.update((prev) =>
      [entry, ...prev].slice(0, VisibilityMonitorComponent.MAX_FEED),
    );
  }

  private buildFeedEntry(state: ActivityState): FeedEntry {
    // Determinamos cuál fue el cambio más reciente
    const vis = state.visibility;
    const idle = state.idle;
    const net = state.network;

    let kind: FeedEventKind = 'attention';
    let label = 'Estado actualizado';
    let detail = '';
    let icon = '📊';
    let isPositive = state.attentionLevel === 'full';

    if (!net.isOnline) {
      kind = 'network'; label = 'Sin conexión'; detail = 'offline';
      icon = '📵'; isPositive = false;
    } else if (!vis.isTabActive || vis.visibilityState === 'hidden') {
      kind = 'visibility';
      label = vis.eventType === 'blur' ? 'Foco perdido' : 'Pestaña oculta';
      detail = `${vis.eventType} · ${vis.visibilityState}`;
      icon = '🙈'; isPositive = false;
    } else if (idle.status === 'idle') {
      kind = 'idle'; label = 'Usuario inactivo';
      detail = `idle desde ${idle.idleSince?.toLocaleTimeString() ?? '—'}`;
      icon = '💤'; isPositive = false;
    } else if (vis.isTabActive && vis.visibilityState === 'visible') {
      kind = 'visibility';
      label = vis.eventType === 'focus' ? 'Foco recuperado' : 'Pestaña visible';
      detail = `${vis.eventType} · visible`;
      icon = '👁️'; isPositive = true;
    } else if (idle.status === 'active') {
      kind = 'idle'; label = 'Usuario activo';
      detail = idle.lastActivityEvent ?? 'actividad';
      icon = '⚡'; isPositive = true;
    }

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind, label, detail, icon, isPositive,
      timestamp: new Date(),
    };
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1_000);
    const h = Math.floor(totalSec / 3_600);
    const m = Math.floor((totalSec % 3_600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }
}
