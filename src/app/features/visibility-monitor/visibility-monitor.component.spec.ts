/**
 * @file visibility-monitor.component.spec.ts
 * @description Tests unitarios para VisibilityMonitorComponent con WebGL, Fullscreen y VM.
 */

import { TestBed, ComponentFixture, fakeAsync, tick } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { signal } from '@angular/core';
import { VisibilityMonitorComponent } from './visibility-monitor.component';
import { BrowserActivityFacade } from '../../core/services/browser-activity.facade';
import { ActivityState } from '../../core/services/browser-activity.model';
import { SecurityTelemetryEvent } from '../../core/services/security-telemetry.service';
import { VmReport } from '../../core/services/vm-detector.service';

describe('VisibilityMonitorComponent', () => {
  let fixture: ComponentFixture<VisibilityMonitorComponent>;
  let component: VisibilityMonitorComponent;

  const mockActivity$ = new Subject<ActivityState>();
  const mockSecurity$ = new Subject<SecurityTelemetryEvent>();

  const isFullscreenSignal = signal<boolean>(false);
  const isWindowFocusedSignal = signal<boolean>(true);
  const isDevToolsOpenSignal = signal<boolean>(false);
  const totalViolationsSignal = signal<number>(0);
  const vmReportSignal = signal<VmReport>({
    isVm: false,
    riskLevel: 'PHYSICAL',
    confidenceScore: 0,
    detectedHypervisor: null,
    gpuVendor: 'NVIDIA',
    gpuRenderer: 'GeForce RTX 4090',
    unmaskedVendor: 'NVIDIA Corporation',
    unmaskedRenderer: 'NVIDIA GeForce RTX 4090 Direct3D11',
    hardwareConcurrency: 16,
    deviceMemoryGb: 16,
    isWebDriver: false,
    screenMetrics: '1920x1080',
    riskFactors: [],
    webglExtensionsCount: 40,
    maxTextureSize: 16384,
    batteryStatus: 'OK',
    analyzedAt: new Date(),
  });

  const mockFacade = {
    activityState$: mockActivity$.asObservable(),
    securityEvents$: mockSecurity$.asObservable(),
    queueSize$: of(0),
    isFullscreen: isFullscreenSignal,
    isWindowFocused: isWindowFocusedSignal,
    isDevToolsOpen: isDevToolsOpenSignal,
    totalViolations: totalViolationsSignal,
    vmReport: vmReportSignal,
    getSessionStats: () => ({
      sessionId: 'test-session',
      startedAt: new Date(),
      durationMs: 120000,
      totalEvents: 5,
      queuedEvents: 0,
      sentBatches: 1,
      idleCount: 0,
      visibilityHiddenCount: 0,
      networkDropCount: 0,
    }),
    requestFullscreen: vi.fn().mockResolvedValue(true),
    exitFullscreen: vi.fn().mockResolvedValue(undefined),
    recheckEnvironment: vi.fn().mockReturnValue(vmReportSignal()),
  };

  beforeEach(async () => {
    isFullscreenSignal.set(false);
    isWindowFocusedSignal.set(true);
    isDevToolsOpenSignal.set(false);
    totalViolationsSignal.set(0);

    await TestBed.configureTestingModule({
      imports: [VisibilityMonitorComponent],
      providers: [
        { provide: BrowserActivityFacade, useValue: mockFacade },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(VisibilityMonitorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('debe crearse correctamente', () => {
    expect(component).toBeTruthy();
  });

  it('debe mostrar el bloqueo de pantalla completa cuando isFullscreen es false', () => {
    isFullscreenSignal.set(false);
    fixture.detectChanges();

    const gate = fixture.nativeElement.querySelector('.fullscreen-gate');
    expect(gate).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('ACCESO BLOQUEADO');
  });

  it('debe desbloquear la interfaz cuando se activa pantalla completa', () => {
    isFullscreenSignal.set(true);
    fixture.detectChanges();

    const gate = fixture.nativeElement.querySelector('.fullscreen-gate');
    expect(gate).toBeFalsy();
  });

  it('debe llamar a requestFullscreen al presionar el botón de desbloqueo', async () => {
    isFullscreenSignal.set(false);
    fixture.detectChanges();

    const ctaBtn = fixture.nativeElement.querySelector('.gate-cta-btn');
    ctaBtn.click();

    expect(mockFacade.requestFullscreen).toHaveBeenCalled();
  });

  it('debe reflejar estado de Máquina Virtual si se detecta', () => {
    vmReportSignal.set({
      ...vmReportSignal(),
      isVm: true,
      riskLevel: 'CRITICAL_VM',
      confidenceScore: 95,
      detectedHypervisor: 'VMware SVGA3D',
      riskFactors: ['GPU coincide con firma VMware'],
    });
    isFullscreenSignal.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('MÁQUINA VIRTUAL DETECTADA');
    expect(fixture.nativeElement.textContent).toContain('VMware SVGA3D');
  });

  it('debe registrar eventos de seguridad en el feed', async () => {
    isFullscreenSignal.set(true);
    fixture.detectChanges();

    const secEvent: SecurityTelemetryEvent = {
      id: 'test-sec-1',
      type: 'devtools_opened',
      label: 'DevTools Detectadas',
      detail: 'Inspector abierto',
      icon: '🛠️',
      severity: 'critical',
      timestamp: new Date(),
    };

    mockSecurity$.next(secEvent);
    fixture.detectChanges();

    expect(component.feedEntries().length).toBeGreaterThan(0);
    expect(component.feedEntries()[0].label).toBe('DevTools Detectadas');
  });
});
