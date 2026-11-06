/**
 * @file browser-activity.facade.ts
 * @description Fachada empresarial que orquesta todos los servicios de monitoreo.
 *
 * Es el ÚNICO punto de entrada que los componentes, guards e interceptores
 * deben consumir. Oculta la complejidad interna de los 4 servicios subyacentes.
 *
 * Expone:
 *  - `activityState$`  : estado unificado (visibilidad + idle + red)
 *  - `visibility$`     : solo visibilidad (Page Visibility API + blur/focus)
 *  - `idle$`           : solo estado de inactividad
 *  - `network$`        : solo estado de red
 *  - `queueSize$`      : eventos pendientes de envío al backend
 *  - `getSessionStats()`: métricas de la sesión actual
 */

import { Injectable, OnDestroy, inject } from '@angular/core';
import { PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  Observable,
  Subject,
  combineLatest,
  interval,
  of,
} from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  takeUntil,
  tap,
} from 'rxjs/operators';

import { BrowserVisibilityService } from './browser-visibility.service';
import { UserIdleService } from './user-idle.service';
import { NetworkStatusService } from './network-status.service';
import { ActivityAuditService } from './activity-audit.service';
import { VmDetectorService, VmReport } from './vm-detector.service';
import { SecurityTelemetryService, SecurityTelemetryEvent } from './security-telemetry.service';
import { BROWSER_ACTIVITY_CONFIG } from './browser-activity.config';
import {
  ActivityState,
  IdleState,
  NetworkState,
  SessionStats,
} from './browser-activity.model';
import { VisibilitySnapshot } from './browser-visibility.model';

/** Calcula el nivel de atención del usuario en base al estado combinado. */
function computeAttentionLevel(
  visibility: VisibilitySnapshot,
  idle: IdleState,
  network: NetworkState,
): ActivityState['attentionLevel'] {
  if (!visibility.isTabActive || visibility.visibilityState === 'hidden') {
    return 'none';
  }
  if (idle.status === 'idle' || !network.isOnline) {
    return 'partial';
  }
  return 'full';
}

@Injectable({ providedIn: 'root' })
export class BrowserActivityFacade implements OnDestroy {
  // ── Servicios internos ───────────────────────────────────────────────────
  private readonly visibilityService = inject(BrowserVisibilityService);
  private readonly idleService = inject(UserIdleService);
  private readonly networkService = inject(NetworkStatusService);
  private readonly auditService = inject(ActivityAuditService);
  private readonly vmDetectorService = inject(VmDetectorService);
  private readonly securityTelemetry = inject(SecurityTelemetryService);
  private readonly config = inject(BROWSER_ACTIVITY_CONFIG);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroy$ = new Subject<void>();

  // ── Signals de Telemetría Avanzada y Máquina Virtual ─────────────────────
  readonly vmReport = this.vmDetectorService.report;
  readonly isFullscreen = this.securityTelemetry.isFullscreen;
  readonly isWindowFocused = this.securityTelemetry.isWindowFocused;
  readonly isDevToolsOpen = this.securityTelemetry.isDevToolsOpen;
  readonly totalViolations = this.securityTelemetry.totalViolations;

  // ── Streams individuales (re-exportados para conveniencia) ───────────────
  readonly visibility$: Observable<VisibilitySnapshot> =
    this.visibilityService.visibility$;

  readonly idle$: Observable<IdleState> = this.idleService.idleState$;

  readonly network$: Observable<NetworkState> =
    this.networkService.networkState$;

  readonly queueSize$: Observable<number> = this.auditService.queueSize$;

  readonly securityEvents$: Observable<SecurityTelemetryEvent> =
    this.securityTelemetry.events$;

  // ── Control de Pantalla Completa ─────────────────────────────────────────
  requestFullscreen(): Promise<boolean> {
    return this.securityTelemetry.requestFullscreen();
  }

  exitFullscreen(): Promise<void> {
    return this.securityTelemetry.exitFullscreen();
  }

  recheckEnvironment(): VmReport {
    return this.vmDetectorService.analyzeEnvironment();
  }

  // ── Estado unificado ─────────────────────────────────────────────────────
  /**
   * Observable principal. Combina los tres streams y:
   *  1. Calcula `attentionLevel`.
   *  2. Encola el evento en el servicio de auditoría.
   *  3. Filtra duplicados semánticos para no sobrecargar la cola.
   */
  readonly activityState$: Observable<ActivityState> = combineLatest({
    visibility: this.visibility$,
    idle: this.idle$,
    network: this.network$,
  }).pipe(
    map(({ visibility, idle, network }) => {
      const state: ActivityState = Object.freeze({
        visibility,
        idle,
        network,
        attentionLevel: computeAttentionLevel(visibility, idle, network),
      });
      return state;
    }),
    // Evitar re-emitir si el estado semántico no cambió
    distinctUntilChanged((a, b) =>
      a.attentionLevel === b.attentionLevel &&
      a.visibility.visibilityState === b.visibility.visibilityState &&
      a.visibility.isTabActive === b.visibility.isTabActive &&
      a.idle.status === b.idle.status &&
      a.network.isOnline === b.network.isOnline,
    ),
    // Efecto: encolar en auditoría
    tap((state) => {
      this.auditService.enqueue('activity_pulse', state);
    }),
    takeUntil(this.destroy$),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;

    // Pulso periódico de actividad (heartbeat al backend)
    if (this.config.enableActivityPulse) {
      this.startActivityPulse();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── API pública ──────────────────────────────────────────────────────────

  /** Métricas de la sesión actual (síncrono, para mostrar en UI). */
  getSessionStats(): SessionStats {
    const base = this.auditService.getStats();
    return {
      sessionId: base.sessionId,
      startedAt: base.startedAt,
      durationMs: base.durationMs,
      totalEvents: base.totalEnqueued,
      queuedEvents: base.queuedEvents,
      sentBatches: base.sentBatches,
      idleCount: 0,           // se puede extender con contador interno
      visibilityHiddenCount: 0,
      networkDropCount: 0,
    };
  }

  // ── Pulso de actividad ───────────────────────────────────────────────────

  /**
   * Emite un pulso periódico solo cuando el usuario está activo y visible,
   * para medir el tiempo real de uso activo en el backend.
   */
  private startActivityPulse(): void {
    interval(this.config.pulseIntervalMs).pipe(
      // Solo pulsar si el usuario está prestando atención
      filter(() => {
        const snap = this.visibilityService.getCurrentSnapshot();
        return snap?.isTabActive === true && snap?.visibilityState === 'visible';
      }),
      tap(() => {
        const snap = this.visibilityService.getCurrentSnapshot();
        if (!snap) return;
        // Construimos un ActivityState mínimo para el pulso
        const pulseState: ActivityState = {
          visibility: snap,
          idle: { status: 'active', idleSince: null, lastActivityEvent: null, timestamp: new Date() },
          network: { isOnline: navigator.onLine, effectiveType: null, timestamp: new Date() },
          attentionLevel: 'full',
        };
        this.auditService.enqueue('activity_pulse', pulseState);
      }),
      takeUntil(this.destroy$),
    ).subscribe();
  }
}
