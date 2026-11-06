/**
 * @file visibility-monitor.component.spec.ts
 * @description Tests unitarios para VisibilityMonitorComponent.
 *
 * Estrategia:
 * - Se provee un mock de BrowserVisibilityService usando un Subject controlado.
 * - Se verifica el renderizado reactivo con signals y la gestión del historial.
 * - Se comprueba que el componente NO se rompe cuando el servicio no emite nada.
 */

import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { ComponentFixture } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { VisibilityMonitorComponent } from './visibility-monitor.component';
import { BrowserVisibilityService } from '../../core/services/browser-visibility.service';
import { VisibilitySnapshot } from '../../core/services/browser-visibility.model';

// ──────────────────────────────────────────────────────────────────────────────
// Mock del servicio
// ──────────────────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<VisibilitySnapshot> = {}): VisibilitySnapshot {
  return Object.freeze({
    visibilityState: 'visible',
    isTabActive: true,
    timestamp: new Date(),
    eventType: 'visibilitychange',
    ...overrides,
  }) as VisibilitySnapshot;
}

class MockBrowserVisibilityService {
  private readonly subject = new Subject<VisibilitySnapshot>();
  readonly visibility$ = this.subject.asObservable();

  emit(snapshot: VisibilitySnapshot): void {
    this.subject.next(snapshot);
  }

  complete(): void {
    this.subject.complete();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite principal
// ──────────────────────────────────────────────────────────────────────────────

describe('VisibilityMonitorComponent', () => {
  let fixture: ComponentFixture<VisibilityMonitorComponent>;
  let component: VisibilityMonitorComponent;
  let mockService: MockBrowserVisibilityService;

  beforeEach(async () => {
    mockService = new MockBrowserVisibilityService();

    await TestBed.configureTestingModule({
      imports: [VisibilityMonitorComponent],
      providers: [
        { provide: BrowserVisibilityService, useValue: mockService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(VisibilityMonitorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    mockService.complete();
    TestBed.resetTestingModule();
  });

  // ── Creación ─────────────────────────────────────────────────────────────

  it('debe crearse sin errores', () => {
    expect(component).toBeTruthy();
  });

  it('currentSnapshot debe ser null antes de recibir eventos', () => {
    expect(component.currentSnapshot()).toBeNull();
  });

  it('eventHistory debe estar vacío al inicio', () => {
    expect(component.eventHistory()).toHaveLength(0);
  });

  // ── Reactividad con el servicio ──────────────────────────────────────────

  it('debe actualizar currentSnapshot al recibir un snapshot del servicio', fakeAsync(() => {
    const snap = makeSnapshot({ isTabActive: false, visibilityState: 'hidden', eventType: 'blur' });

    mockService.emit(snap);
    tick();
    fixture.detectChanges();

    expect(component.currentSnapshot()).toEqual(snap);
  }));

  it('debe añadir eventos al historial', fakeAsync(() => {
    const snap1 = makeSnapshot({ eventType: 'blur', isTabActive: false });
    const snap2 = makeSnapshot({ eventType: 'focus', isTabActive: true });

    mockService.emit(snap1);
    tick();
    mockService.emit(snap2);
    tick();
    fixture.detectChanges();

    // El más reciente va primero
    expect(component.eventHistory()[0]).toEqual(snap2);
    expect(component.eventHistory()[1]).toEqual(snap1);
    expect(component.eventHistory()).toHaveLength(2);
  }));

  it('el historial no debe superar 10 elementos', fakeAsync(() => {
    for (let i = 0; i < 15; i++) {
      mockService.emit(makeSnapshot({ eventType: i % 2 === 0 ? 'blur' : 'focus' }));
      tick();
    }
    fixture.detectChanges();

    expect(component.eventHistory().length).toBeLessThanOrEqual(10);
  }));

  // ── Renderizado del template ──────────────────────────────────────────────

  it('debe mostrar badge ACTIVA cuando isTabActive=true', fakeAsync(() => {
    mockService.emit(makeSnapshot({ isTabActive: true }));
    tick();
    fixture.detectChanges();

    const badge: HTMLElement = fixture.nativeElement.querySelector('.status-badge');
    expect(badge?.textContent?.trim()).toBe('ACTIVA');
    expect(badge?.classList).toContain('badge--active');
  }));

  it('debe mostrar badge INACTIVA cuando isTabActive=false', fakeAsync(() => {
    mockService.emit(makeSnapshot({ isTabActive: false }));
    tick();
    fixture.detectChanges();

    const badge: HTMLElement = fixture.nativeElement.querySelector('.status-badge');
    expect(badge?.textContent?.trim()).toBe('INACTIVA');
    expect(badge?.classList).toContain('badge--inactive');
  }));

  it('debe mostrar el mensaje "Esperando eventos..." cuando el historial está vacío', () => {
    const empty: HTMLElement = fixture.nativeElement.querySelector('.history-empty');
    expect(empty?.textContent?.trim()).toBe('Esperando eventos...');
  });

  it('debe mostrar los items del historial al recibir eventos', fakeAsync(() => {
    mockService.emit(makeSnapshot({ eventType: 'blur' }));
    mockService.emit(makeSnapshot({ eventType: 'focus' }));
    tick();
    fixture.detectChanges();

    const items: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.history-item');
    expect(items.length).toBe(2);
  }));

  it('la tarjeta de estado debe usar clase card--visible cuando la pestaña es visible', fakeAsync(() => {
    mockService.emit(makeSnapshot({ isTabActive: true, visibilityState: 'visible' }));
    tick();
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.state-card');
    expect(card?.classList).toContain('card--visible');
  }));

  it('la tarjeta de estado debe usar clase card--hidden cuando la pestaña está oculta', fakeAsync(() => {
    mockService.emit(makeSnapshot({ isTabActive: false, visibilityState: 'hidden' }));
    tick();
    fixture.detectChanges();

    const card: HTMLElement = fixture.nativeElement.querySelector('.state-card');
    expect(card?.classList).toContain('card--hidden');
  }));

  it('debe mostrar correctamente el eventType en la tarjeta de estado', fakeAsync(() => {
    mockService.emit(makeSnapshot({ eventType: 'beforeunload' }));
    tick();
    fixture.detectChanges();

    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.state-row code');
    const eventTypeRow = Array.from(rows).find((r) => r.textContent?.includes('beforeunload'));
    expect(eventTypeRow).toBeTruthy();
  }));
});
