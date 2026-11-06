/**
 * @file activity-audit.service.ts
 * @description Servicio de auditoría empresarial con:
 *
 *  - Cola en memoria con respaldo en localStorage (resiliente a recargas).
 *  - Envío en batches con intervalo configurable vía HttpClient.
 *  - Retry con backoff exponencial en caso de fallo HTTP.
 *  - Uso de navigator.sendBeacon en el evento beforeunload para garantizar
 *    la entrega del último lote antes de cerrar la pestaña.
 *  - Flush inmediato al recuperar conectividad (online event).
 *  - Pulso de actividad periódico para medir tiempo activo en backend.
 *  - HttpClient es OPCIONAL (inject con {optional: true}) para no romper
 *    apps que no provean provideHttpClient().
 */

import {
  Injectable,
  NgZone,
  OnDestroy,
  PLATFORM_ID,
  inject,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  Subject,
  fromEvent,
  interval,
  timer,
} from 'rxjs';
import {
  catchError,
  filter,
  map,
  retry,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs/operators';

import { BROWSER_ACTIVITY_CONFIG } from './browser-activity.config';
import {
  ActivityState,
  AuditBatch,
  AuditEvent,
  AuditEventType,
} from './browser-activity.model';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Servicio
// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ActivityAuditService implements OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly ngZone = inject(NgZone);
  private readonly config = inject(BROWSER_ACTIVITY_CONFIG);
  // HttpClient es OPCIONAL: si no está provisto, se degrada gracefully a solo logs.
  private readonly http = inject(HttpClient, { optional: true });

  // ── Estado interno ───────────────────────────────────────────────────────
  private readonly sessionId = generateId();
  private readonly sessionStart = new Date();
  private readonly destroy$ = new Subject<void>();

  /** Cola de eventos en memoria. */
  private readonly queue$ = new BehaviorSubject<AuditEvent[]>([]);

  // ── Métricas de sesión ───────────────────────────────────────────────────
  private sentBatches = 0;
  private totalEnqueued = 0;

  // ── Observables públicos ─────────────────────────────────────────────────
  /** Número de eventos pendientes de envío. */
  readonly queueSize$: Observable<number> = this.queue$.pipe(
    map((q) => q.length),
  );

  readonly sessionId$ = this.sessionId;
  readonly sessionStart$ = this.sessionStart;

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;

    this.restoreQueueFromStorage();
    this.startBatchFlush();
    this.setupOnlineFlush();
    this.setupBeaconOnUnload();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── API pública ──────────────────────────────────────────────────────────

  /**
   * Encola un evento de auditoría.
   * Llamado por el Facade cada vez que el ActivityState cambia.
   */
  enqueue(type: AuditEventType, state: ActivityState): void {
    const event: AuditEvent = Object.freeze({
      id: generateId(),
      sessionId: this.sessionId,
      sessionStart: this.sessionStart.toISOString(),
      type,
      timestamp: new Date().toISOString(),
      visibilityState: state.visibility.visibilityState,
      isTabActive: state.visibility.isTabActive,
      idleStatus: state.idle.status,
      isOnline: state.network.isOnline,
      attentionLevel: state.attentionLevel,
      url: location.href,
      userAgent: navigator.userAgent,
      metadata: {
        eventType: state.visibility.eventType,
        lastActivityEvent: state.idle.lastActivityEvent,
        effectiveType: state.network.effectiveType,
      },
    });

    this.totalEnqueued++;

    // FIFO con capping al máximo configurado
    this.queue$.next([
      ...this.queue$.value.slice(-(this.config.maxQueueSize - 1)),
      event,
    ]);

    this.persistQueueToStorage();
  }

  /** Métricas de sesión para el componente de UI. */
  getStats() {
    return {
      sessionId: this.sessionId,
      startedAt: this.sessionStart,
      durationMs: Date.now() - this.sessionStart.getTime(),
      totalEnqueued: this.totalEnqueued,
      queuedEvents: this.queue$.value.length,
      sentBatches: this.sentBatches,
    };
  }

  // ── Lógica de flush ──────────────────────────────────────────────────────

  /** Flush periódico basado en intervalo configurable. */
  private startBatchFlush(): void {
    this.ngZone.runOutsideAngular(() => {
      interval(this.config.batchIntervalMs).pipe(
        filter(() => this.queue$.value.length > 0),
        switchMap(() => this.sendBatch()),
        takeUntil(this.destroy$),
      ).subscribe();
    });
  }

  /** Flush inmediato cuando el navegador recupera conexión. */
  private setupOnlineFlush(): void {
    this.ngZone.runOutsideAngular(() => {
      fromEvent(window, 'online').pipe(
        filter(() => this.queue$.value.length > 0),
        switchMap(() => this.sendBatch()),
        takeUntil(this.destroy$),
      ).subscribe();
    });
  }

  /**
   * Usa sendBeacon para garantizar el envío del último lote
   * cuando el usuario cierra o recarga la pestaña.
   */
  private setupBeaconOnUnload(): void {
    this.ngZone.runOutsideAngular(() => {
      fromEvent(window, 'beforeunload').pipe(
        takeUntil(this.destroy$),
      ).subscribe(() => {
        const events = this.queue$.value;
        if (events.length === 0) return;

        const batch = this.buildBatch(events);

        if (navigator.sendBeacon) {
          const sent = navigator.sendBeacon(
            this.config.beaconEndpoint,
            JSON.stringify(batch),
          );
          if (sent) {
            this.queue$.next([]);
            this.clearStorage();
            this.sentBatches++;
          }
        }
      });
    });
  }

  /** Construye el payload del batch y lo envía vía HttpClient con retry. */
  private sendBatch(): Observable<void> {
    const events = this.queue$.value;
    if (events.length === 0) return EMPTY;

    const batch = this.buildBatch(events);

    // Log de desarrollo (siempre)
    console.groupCollapsed(
      `%c📦 [ActivityAudit] Enviando batch: ${batch.count} evento(s)`,
      'color: #6366f1; font-weight: bold',
    );
    console.table(events.map((e) => ({
      type: e.type,
      visibility: e.visibilityState,
      idle: e.idleStatus,
      attention: e.attentionLevel,
      time: e.timestamp,
    })));
    console.groupEnd();

    if (!this.http) {
      // Sin HttpClient: solo log — útil en desarrollo sin backend
      console.warn('[ActivityAudit] HttpClient no disponible. Eventos solo en log.');
      this.queue$.next([]);
      this.clearStorage();
      return EMPTY;
    }

    return this.http.post<void>(this.config.auditEndpoint, batch).pipe(
      tap(() => {
        this.queue$.next([]);
        this.clearStorage();
        this.sentBatches++;
        console.info(`[ActivityAudit] ✅ Batch ${batch.batchId} enviado (${batch.count} eventos)`);
      }),
      // Retry con backoff exponencial: 1s → 2s → 4s
      retry({
        count: 3,
        delay: (_, attempt) => timer(Math.pow(2, attempt - 1) * 1_000),
      }),
      catchError((err) => {
        console.error('[ActivityAudit] ❌ Flush fallido, eventos retenidos:', err.message ?? err);
        this.persistQueueToStorage(); // asegura persistencia ante fallo
        return EMPTY;
      }),
    );
  }

  private buildBatch(events: AuditEvent[]): AuditBatch {
    return {
      batchId: generateId(),
      sessionId: this.sessionId,
      events,
      count: events.length,
      flushedAt: new Date().toISOString(),
    };
  }

  // ── localStorage resilience ──────────────────────────────────────────────

  private persistQueueToStorage(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(this.config.storageKey, JSON.stringify(this.queue$.value));
    } catch {
      // QuotaExceededError — ignorar silenciosamente
    }
  }

  private restoreQueueFromStorage(): void {
    try {
      const raw = localStorage.getItem(this.config.storageKey);
      if (!raw) return;
      const events: AuditEvent[] = JSON.parse(raw);
      if (Array.isArray(events) && events.length > 0) {
        this.queue$.next(events);
        console.info(`[ActivityAudit] 🔄 Restaurados ${events.length} evento(s) desde localStorage`);
      }
    } catch {
      // JSON corrupto — ignorar
    }
  }

  private clearStorage(): void {
    try {
      localStorage.removeItem(this.config.storageKey);
    } catch {
      // ignorar
    }
  }
}
