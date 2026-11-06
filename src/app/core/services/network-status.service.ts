/**
 * @file network-status.service.ts
 * @description Monitorea el estado de conectividad del navegador (online/offline)
 * y, cuando está disponible, la calidad de conexión via Network Information API.
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
  map,
  shareReplay,
  takeUntil,
} from 'rxjs/operators';

import { NetworkState } from './browser-activity.model';

/** Extiende la interfaz Navigator con la Network Information API (experimental). */
interface NavigatorWithConnection extends Navigator {
  readonly connection?: {
    readonly effectiveType?: string;
    addEventListener(type: string, listener: EventListener): void;
  };
}

@Injectable({ providedIn: 'root' })
export class NetworkStatusService implements OnDestroy {
  private readonly ngZone = inject(NgZone);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroy$ = new Subject<void>();

  /**
   * Stream reactivo del estado de red.
   * - Emite el estado actual al suscribirse.
   * - Emite al cambiar entre online/offline.
   * - Incluye `effectiveType` si Network Information API está disponible.
   */
  readonly networkState$: Observable<NetworkState>;

  constructor() {
    this.networkState$ = this.buildNetworkStream();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private buildNetworkStream(): Observable<NetworkState> {
    if (!isPlatformBrowser(this.platformId)) {
      return of(this.buildState(true));
    }

    return new Observable<NetworkState>((observer) => {
      this.ngZone.runOutsideAngular(() => {
        const online$ = fromEvent(window, 'online').pipe(
          map(() => this.buildState(true)),
        );

        const offline$ = fromEvent(window, 'offline').pipe(
          map(() => this.buildState(false)),
        );

        const initial$ = of(this.buildState(navigator.onLine));

        // Network Information API: escucha cambios de tipo de conexión
        const nav = navigator as NavigatorWithConnection;
        const connection$ = nav.connection
          ? new Observable<NetworkState>((connObserver) => {
              const handler = () =>
                connObserver.next(this.buildState(navigator.onLine));
              nav.connection!.addEventListener('change', handler as EventListener);
            })
          : of<NetworkState>();

        const stream$ = merge(initial$, online$, offline$, connection$).pipe(
          distinctUntilChanged((a, b) => a.isOnline === b.isOnline && a.effectiveType === b.effectiveType),
          takeUntil(this.destroy$),
        );

        const sub = stream$.subscribe({
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

  private buildState(isOnline: boolean): NetworkState {
    const nav = navigator as NavigatorWithConnection;
    return Object.freeze({
      isOnline,
      effectiveType: nav.connection?.effectiveType ?? null,
      timestamp: new Date(),
    });
  }
}
