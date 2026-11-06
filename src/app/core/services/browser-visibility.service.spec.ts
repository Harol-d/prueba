/**
 * @file browser-visibility.service.spec.ts
 * @description Tests unitarios para BrowserVisibilityService.
 *
 * Estrategia de testing:
 * - Se usa Vitest (configurado en este proyecto Angular 22) con @angular/core/testing.
 * - Los eventos DOM se simulan con `dispatchEvent` directamente sobre document/window.
 * - Se usa `fakeAsync` + `tick` para controlar la temporalidad del stream inicial.
 * - Se espía `console.groupCollapsed` para verificar la función de auditoría
 *   sin producir output ruidoso en el log de CI.
 */

import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { PLATFORM_ID } from '@angular/core';
import { firstValueFrom, skip, take, toArray } from 'rxjs';
import { BrowserVisibilityService } from './browser-visibility.service';
import { VisibilitySnapshot } from './browser-visibility.model';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers de test
// ──────────────────────────────────────────────────────────────────────────────

/** Despacha un evento sintético en document y espera a que el stream procese. */
function fireDocumentEvent(type: string): void {
  document.dispatchEvent(new Event(type));
}

/** Despacha un evento sintético en window. */
function fireWindowEvent(type: string): void {
  window.dispatchEvent(new Event(type));
}

/** Recolecta N snapshots del stream y los devuelve como array. */
async function collectSnapshots(
  service: BrowserVisibilityService,
  count: number,
): Promise<VisibilitySnapshot[]> {
  return firstValueFrom(service.visibility$.pipe(take(count), toArray()));
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite principal
// ──────────────────────────────────────────────────────────────────────────────

describe('BrowserVisibilityService', () => {
  let service: BrowserVisibilityService;

  // Silencia los logs de auditoría durante los tests
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    TestBed.configureTestingModule({
      providers: [BrowserVisibilityService],
    });

    service = TestBed.inject(BrowserVisibilityService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  // ── Instanciación ────────────────────────────────────────────────────────

  it('debe crearse correctamente', () => {
    expect(service).toBeTruthy();
  });

  it('visibility$ debe ser un Observable', () => {
    expect(service.visibility$).toBeDefined();
    expect(typeof service.visibility$.subscribe).toBe('function');
  });

  // ── Emisión inicial ──────────────────────────────────────────────────────

  it('debe emitir un snapshot inicial al suscribirse', async () => {
    const snapshot = await firstValueFrom(service.visibility$);

    expect(snapshot).toBeDefined();
    expect(snapshot.timestamp).toBeInstanceOf(Date);
    expect(['visible', 'hidden']).toContain(snapshot.visibilityState);
    expect(typeof snapshot.isTabActive).toBe('boolean');
    expect(snapshot.eventType).toBe('visibilitychange');
  });

  it('el snapshot inicial debe ser inmutable (Object.freeze)', async () => {
    const snapshot = await firstValueFrom(service.visibility$);

    expect(() => {
      // @ts-expect-error — Probamos que el objeto está congelado
      snapshot.isTabActive = !snapshot.isTabActive;
    }).toThrow();

    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  // ── Evento visibilitychange ──────────────────────────────────────────────

  it('debe emitir snapshot con visibilityState="hidden" al ocurrir visibilitychange', async () => {
    // Colectamos el siguiente evento
    const snapshotPromise = firstValueFrom(service.visibility$.pipe(skip(1), take(1)));

    // Simulamos que el documento se oculta
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    fireDocumentEvent('visibilitychange');

    const snapshot = await snapshotPromise;
    expect(snapshot?.visibilityState).toBe('hidden');
    expect(snapshot?.eventType).toBe('visibilitychange');

    // Restauramos
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  // ── Evento blur ──────────────────────────────────────────────────────────

  it('debe emitir isTabActive=false al disparar blur en window', async () => {
    const snapshotPromise = firstValueFrom(service.visibility$.pipe(skip(1), take(1)));

    fireWindowEvent('blur');

    const snapshot = await snapshotPromise;
    expect(snapshot?.isTabActive).toBe(false);
    expect(snapshot?.eventType).toBe('blur');
  });

  // ── Evento focus ─────────────────────────────────────────────────────────

  it('debe emitir isTabActive=true al disparar focus en window', async () => {
    // Primero emitimos un blur para cambiar el estado
    fireWindowEvent('blur');

    const snapshotPromise = firstValueFrom(service.visibility$.pipe(skip(1), take(1)));
    fireWindowEvent('focus');

    const snapshot = await snapshotPromise;
    expect(snapshot?.eventType).toBe('focus');
    expect(snapshot?.isTabActive).toBe(true);
  });

  // ── Evento beforeunload ──────────────────────────────────────────────────

  it('debe emitir visibilityState="hidden" e isTabActive=false en beforeunload', async () => {
    const snapshotPromise = firstValueFrom(service.visibility$.pipe(skip(1), take(1)));

    fireWindowEvent('beforeunload');

    const snapshot = await snapshotPromise;
    expect(snapshot?.visibilityState).toBe('hidden');
    expect(snapshot?.isTabActive).toBe(false);
    expect(snapshot?.eventType).toBe('beforeunload');
  });

  // ── distinctUntilChanged ─────────────────────────────────────────────────

  it('no debe emitir si el nuevo evento tiene el mismo estado semántico', async () => {
    const emitted: VisibilitySnapshot[] = [];
    const sub = service.visibility$.subscribe((s) => emitted.push(s));

    // Disparar el mismo evento dos veces seguidas sin cambio de estado
    fireWindowEvent('focus');
    fireWindowEvent('focus');

    // Solo debe haber añadido como máximo 1 nuevo emisión (si el estado cambió)
    // pero nunca duplicados del mismo estado semántico
    const uniqueStates = new Set(emitted.map((s) => `${s.visibilityState}-${s.isTabActive}-${s.eventType}`));
    expect(uniqueStates.size).toBe(emitted.length);

    sub.unsubscribe();
  });

  // ── shareReplay ──────────────────────────────────────────────────────────

  it('dos suscriptores deben recibir el mismo último valor (shareReplay)', async () => {
    const snap1 = await firstValueFrom(service.visibility$);
    const snap2 = await firstValueFrom(service.visibility$);

    // Ambos reciben el mismo snapshot cacheado (misma referencia)
    expect(snap1).toBe(snap2);
  });

  // ── getCurrentSnapshot ───────────────────────────────────────────────────

  it('getCurrentSnapshot() debe devolver un snapshot válido en entorno browser', () => {
    const snapshot = service.getCurrentSnapshot();

    expect(snapshot).not.toBeNull();
    expect(snapshot?.timestamp).toBeInstanceOf(Date);
    expect(['visible', 'hidden']).toContain(snapshot?.visibilityState);
  });

  // ── Auditoría ────────────────────────────────────────────────────────────

  it('debe llamar a console.groupCollapsed al emitir un snapshot (auditoría)', async () => {
    await firstValueFrom(service.visibility$);

    expect(consoleSpy).toHaveBeenCalled();
    // El primer argumento contiene el label con el estilo CSS
    const callArg = consoleSpy.mock.calls[0][0] as string;
    expect(callArg).toContain('[BrowserVisibility]');
  });

  // ── SSR (PLATFORM_SERVER) ────────────────────────────────────────────────

  describe('en entorno SSR (PLATFORM_SERVER)', () => {
    beforeEach(() => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          BrowserVisibilityService,
          { provide: PLATFORM_ID, useValue: 'server' },
        ],
      });
      service = TestBed.inject(BrowserVisibilityService);
    });

    it('debe emitir un snapshot estático y no registrar listeners DOM', async () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      const snapshot = await firstValueFrom(service.visibility$);

      expect(snapshot.visibilityState).toBe('visible');
      expect(snapshot.isTabActive).toBe(true);
      expect(snapshot.eventType).toBe('visibilitychange');
      // No debe haberse registrado ningún listener en el DOM
      expect(addEventListenerSpy).not.toHaveBeenCalled();
    });

    it('getCurrentSnapshot() debe retornar null en SSR', () => {
      expect(service.getCurrentSnapshot()).toBeNull();
    });
  });

  // ── Limpieza / OnDestroy ─────────────────────────────────────────────────

  it('ngOnDestroy debe completar el stream sin errors', () => {
    let completed = false;
    service.visibility$.subscribe({ complete: () => (completed = true) });

    service.ngOnDestroy();

    expect(completed).toBe(true);
  });
});
