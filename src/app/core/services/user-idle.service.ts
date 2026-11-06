/**
 * @file user-idle.service.ts
 * @description Detecta inactividad del usuario monitoreando eventos de mouse,
 * teclado, touch, scroll y puntero.
 *
 * Patrón:
 *   Cualquier evento de actividad → reinicia timer (switchMap + timer)
 *   Timer vence sin actividad    → emite estado 'idle'
 *   Siguiente actividad          → emite estado 'active'
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
  timer,
} from 'rxjs';
import {
  distinctUntilChanged,
  map,
  shareReplay,
  switchMap,
  takeUntil,
} from 'rxjs/operators';

import { BROWSER_ACTIVITY_CONFIG } from './browser-activity.config';
import {
  IdleState,
  USER_ACTIVITY_EVENTS,
  UserActivityEvent,
} from './browser-activity.model';

@Injectable({ providedIn: 'root' })
export class UserIdleService implements OnDestroy {
  private readonly ngZone = inject(NgZone);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly config = inject(BROWSER_ACTIVITY_CONFIG);
  private readonly destroy$ = new Subject<void>();

  /**
   * Stream reactivo del estado de inactividad.
   * - Emite 'active' inmediatamente al iniciar.
   * - Emite 'idle' cuando transcurre `idleTimeoutMs` sin actividad.
   * - Emite 'active' de nuevo al detectar cualquier actividad del usuario.
   */
  readonly idleState$: Observable<IdleState>;

  constructor() {
    this.idleState$ = this.buildIdleStream();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private buildIdleStream(): Observable<IdleState> {
    if (!isPlatformBrowser(this.platformId)) {
      return of(this.activeState(null));
    }

    return new Observable<IdleState>((observer) => {
      this.ngZone.runOutsideAngular(() => {
        // Escuchamos TODOS los eventos de actividad en el documento
        const activity$ = merge(
          ...USER_ACTIVITY_EVENTS.map((eventName) =>
            fromEvent<Event>(document, eventName).pipe(
              map(() => eventName as UserActivityEvent),
            ),
          ),
        );

        /**
         * Lógica central:
         *  1. `of(null)` arranca el stream inmediatamente.
         *  2. Cada evento de actividad (o el inicial) dispara switchMap.
         *  3. switchMap cancela el timer anterior y emite:
         *     a) INMEDIATAMENTE: estado 'active'
         *     b) Después de idleTimeoutMs: estado 'idle'
         *  4. Si llega otro evento antes del timeout, switchMap reinicia todo.
         */
        const idle$ = merge(of(null as UserActivityEvent | null), activity$).pipe(
          switchMap((lastEvent) =>
            merge(
              of(this.activeState(lastEvent)),
              timer(this.config.idleTimeoutMs).pipe(
                map(() => this.idleState(lastEvent)),
              ),
            ),
          ),
          distinctUntilChanged((a, b) => a.status === b.status),
          takeUntil(this.destroy$),
        );

        const sub = idle$.subscribe({
          next: (state) => this.ngZone.run(() => observer.next(state)),
          error: (err) => this.ngZone.run(() => observer.error(err)),
          complete: () => this.ngZone.run(() => observer.complete()),
        });

        return () => sub.unsubscribe();
      });
    }).pipe(
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

  private activeState(lastEvent: UserActivityEvent | null): IdleState {
    return Object.freeze({
      status: 'active',
      idleSince: null,
      lastActivityEvent: lastEvent,
      timestamp: new Date(),
    });
  }

  private idleState(lastEvent: UserActivityEvent | null): IdleState {
    return Object.freeze({
      status: 'idle',
      idleSince: new Date(),
      lastActivityEvent: lastEvent,
      timestamp: new Date(),
    });
  }
}
