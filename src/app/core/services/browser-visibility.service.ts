/**
 * @file browser-visibility.service.ts
 * @description Servicio Angular para monitorear la visibilidad y actividad del usuario
 * en el navegador mediante la Page Visibility API y eventos de ventana complementarios.
 *
 * Características principales:
 * - Usa Page Visibility API (`visibilitychange`) como mecanismo primario.
 * - Complementa con `blur`, `focus` y `beforeunload` para cubrir casos no detectados.
 * - Ejecuta todos los listeners FUERA de la zona Angular (NgZone.runOutsideAngular)
 *   para evitar ciclos innecesarios de Change Detection.
 * - Re-entra a la zona Angular únicamente al emitir el estado al suscriptor.
 * - Compatible con SSR (Angular Universal / @angular/ssr): verifica disponibilidad de
 *   `document` y `window` antes de acceder a ellos.
 * - Expone un Observable limpio con `shareReplay(1)` y `distinctUntilChanged`.
 * - Incluye función de auditoría que simula el envío de eventos al backend.
 */

import {
  Injectable,
  NgZone,
  OnDestroy,
  PLATFORM_ID,
  inject,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  Observable,
  Subject,
  fromEvent,
  merge,
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
import {
  AuditPayload,
  VisibilityEventType,
  VisibilitySnapshot,
  VisibilityState,
} from './browser-visibility.model';

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/** Genera un ID de sesión simple basado en timestamp + random para identificar
 *  la sesión en los logs de auditoría. En producción reemplazar por UUID v4. */
function generateSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Serializa un VisibilitySnapshot a AuditPayload listo para transporte HTTP. */
function toAuditPayload(
  snapshot: VisibilitySnapshot,
  sessionId: string,
): AuditPayload {
  return {
    sessionId,
    visibilityState: snapshot.visibilityState,
    isTabActive: snapshot.isTabActive,
    timestamp: snapshot.timestamp.toISOString(),
    eventType: snapshot.eventType,
    userAgent:
      typeof navigator !== 'undefined' ? navigator.userAgent : 'SSR',
    url: typeof location !== 'undefined' ? location.href : 'SSR',
  };
}

// ---------------------------------------------------------------------------
// Comparador para distinctUntilChanged
// ---------------------------------------------------------------------------

/** Compara dos snapshots por valor semántico (ignora el timestamp). */
function snapshotsAreEqual(
  a: VisibilitySnapshot,
  b: VisibilitySnapshot,
): boolean {
  return (
    a.visibilityState === b.visibilityState &&
    a.isTabActive === b.isTabActive &&
    a.eventType === b.eventType
  );
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class BrowserVisibilityService implements OnDestroy {
  // ── Dependencias ────────────────────────────────────────────────────────
  private readonly ngZone = inject(NgZone);
  private readonly platformId = inject(PLATFORM_ID);

  // ── Estado interno ───────────────────────────────────────────────────────
  private readonly sessionId = generateSessionId();
  private readonly destroy$ = new Subject<void>();

  // ── Observable público ───────────────────────────────────────────────────
  /**
   * Stream reactivo del estado de visibilidad.
   *
   * - Emite inmediatamente el estado actual al suscribirse (startWith).
   * - Solo emite cuando el estado semántico cambia (distinctUntilChanged).
   * - Compartido entre todos los suscriptores con el último valor en caché (shareReplay(1)).
   * - En entornos SSR emite un único snapshot estático y completa.
   */
  readonly visibility$: Observable<VisibilitySnapshot>;

  constructor() {
    this.visibility$ = this.buildVisibilityStream();
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── API pública auxiliar ─────────────────────────────────────────────────

  /**
   * Devuelve el snapshot actual de forma síncrona (útil para guards o interceptores).
   * Retorna `null` en contextos SSR donde no hay DOM disponible.
   */
  getCurrentSnapshot(): VisibilitySnapshot | null {
    if (!isPlatformBrowser(this.platformId)) return null;

    return this.buildSnapshot(
      (document.visibilityState as VisibilityState) ?? 'visible',
      document.hasFocus(),
      'visibilitychange',
    );
  }

  // ── Construcción del stream ──────────────────────────────────────────────

  private buildVisibilityStream(): Observable<VisibilitySnapshot> {
    // En SSR no hay DOM; devolvemos un observable estático que emite el estado
    // "visible" y completa de inmediato, sin registrar ningún listener.
    if (!isPlatformBrowser(this.platformId)) {
      return of(this.buildSnapshot('visible', true, 'visibilitychange'));
    }

    // Creamos el stream FUERA de la zona Angular para evitar que cada evento
    // DOM dispare un ciclo de Change Detection.
    return new Observable<VisibilitySnapshot>((observer) => {
      this.ngZone.runOutsideAngular(() => {
        // ── Evento primario: Page Visibility API ──────────────────────────
        const visibilityChange$ = fromEvent(document, 'visibilitychange').pipe(
          map(() =>
            this.buildSnapshot(
              document.visibilityState as VisibilityState,
              document.hasFocus(),
              'visibilitychange',
            ),
          ),
        );

        // ── Evento complementario: pérdida de foco (cambio a otra ventana) ─
        const blur$ = fromEvent(window, 'blur').pipe(
          map(() =>
            this.buildSnapshot(
              document.visibilityState as VisibilityState,
              false,
              'blur',
            ),
          ),
        );

        // ── Evento complementario: recuperación de foco ───────────────────
        const focus$ = fromEvent(window, 'focus').pipe(
          map(() =>
            this.buildSnapshot(
              document.visibilityState as VisibilityState,
              true,
              'focus',
            ),
          ),
        );

        // ── Evento complementario: cierre / recarga de página ─────────────
        const beforeUnload$ = fromEvent(window, 'beforeunload').pipe(
          map(() =>
            this.buildSnapshot('hidden', false, 'beforeunload'),
          ),
        );

        // ── Estado inicial (snapshot en el momento de la suscripción) ─────
        const initial$ = of(
          this.buildSnapshot(
            document.visibilityState as VisibilityState,
            document.hasFocus(),
            'visibilitychange',
          ),
        );

        // ── Merge de todos los streams ────────────────────────────────────
        const merged$ = merge(
          initial$,
          visibilityChange$,
          blur$,
          focus$,
          beforeUnload$,
        ).pipe(
          // Filtramos snapshots sin cambio semántico real
          distinctUntilChanged(snapshotsAreEqual),
          // Efecto secundario: auditoría antes de emitir al suscriptor
          tap((snapshot) => this.audit(snapshot)),
          // Cancelación automática al destruir el servicio
          takeUntil(this.destroy$),
        );

        // Re-entramos a la zona Angular SOLO para emitir al suscriptor,
        // manteniendo el procesamiento interno fuera de la zona.
        const subscription = merged$.subscribe({
          next: (snapshot) =>
            this.ngZone.run(() => observer.next(snapshot)),
          error: (err) =>
            this.ngZone.run(() => observer.error(err)),
          complete: () =>
            this.ngZone.run(() => observer.complete()),
        });

        // Retornamos la función de limpieza del Observable
        return () => subscription.unsubscribe();
      });
    }).pipe(
      // Compartimos la misma suscripción entre todos los consumers y
      // reproducimos el último valor para los nuevos suscriptores tardíos.
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

  // ── Helpers privados ─────────────────────────────────────────────────────

  /** Construye un VisibilitySnapshot inmutable. */
  private buildSnapshot(
    visibilityState: VisibilityState,
    isTabActive: boolean,
    eventType: VisibilityEventType,
  ): VisibilitySnapshot {
    return Object.freeze({
      visibilityState,
      isTabActive,
      timestamp: new Date(),
      eventType,
    });
  }

  /**
   * Función de auditoría: registra el evento localmente y simula el envío
   * al backend mediante un `console` estructurado.
   *
   * En producción, reemplazar el bloque `// TODO` por una llamada HTTP:
   * `this.http.post('/api/audit/visibility', payload).subscribe()`.
   */
  private audit(snapshot: VisibilitySnapshot): void {
    const payload: AuditPayload = toAuditPayload(snapshot, this.sessionId);

    // Log estructurado con estilo visual diferenciado por estado
    const icon = snapshot.isTabActive ? '🟢' : '🔴';
    const style = snapshot.isTabActive
      ? 'color: #22c55e; font-weight: bold'
      : 'color: #ef4444; font-weight: bold';

    console.groupCollapsed(
      `%c${icon} [BrowserVisibility] ${snapshot.eventType.toUpperCase()} — ${payload.timestamp}`,
      style,
    );
    console.table({
      visibilityState: payload.visibilityState,
      isTabActive: payload.isTabActive,
      eventType: payload.eventType,
      sessionId: payload.sessionId,
    });
    console.groupEnd();

    // TODO: Enviar al backend de auditoría
    // this.http.post<void>('/api/audit/visibility', payload).pipe(
    //   retry({ count: 2, delay: 1000 }),
    //   catchError((err) => {
    //     console.error('[BrowserVisibility] Error al enviar auditoría:', err);
    //     return EMPTY;
    //   }),
    // ).subscribe();
  }
}
