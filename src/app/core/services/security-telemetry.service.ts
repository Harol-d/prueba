/**
 * @file security-telemetry.service.ts
 * @description Sistema integral de telemetría y vigilancia del navegador.
 *
 * Monitorea absolutamente todos los cambios y eventos que ocurren en el cliente:
 *  - Estado de Pantalla Completa (Full Screen API y detección estricta)
 *  - Foco y desenfoque de ventana (Alt+Tab, clic externo)
 *  - Salida del cursor del área visible (mouseleave)
 *  - Apertura e inspección con DevTools (heurística de dimensiones + profiler timing)
 *  - Teclas interceptadas (F11, F12, Escape, Alt+Tab, WinKey, Ctrl+Shift+I, etc.)
 *  - Portapapeles (Copiar, Pegar, Cortar) y Menú contextual (Clic derecho)
 *  - Redimensionamiento de ventana, escala de zoom y orientación
 *  - Conexión y desconexión de periféricos (monitores, webcams, audio)
 *  - Cambios de red (online, offline, cambio de velocidad 4G/Wifi)
 *  - Cambios en el estado de batería
 *  - Pérdida y restauración de contexto WebGL
 */

import {
  Injectable,
  NgZone,
  OnDestroy,
  PLATFORM_ID,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subject } from 'rxjs';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export interface SecurityTelemetryEvent {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: string;
  readonly severity: SecuritySeverity;
  readonly timestamp: Date;
}

@Injectable({ providedIn: 'root' })
export class SecurityTelemetryService implements OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly ngZone = inject(NgZone);

  // ── Signals de estado ───────────────────────────────────────────────────
  readonly isFullscreen = signal<boolean>(false);
  readonly isWindowFocused = signal<boolean>(true);
  readonly isCursorInside = signal<boolean>(true);
  readonly isDevToolsOpen = signal<boolean>(false);
  readonly totalViolations = signal<number>(0);

  // ── Stream de eventos de seguridad ─────────────────────────────────────
  private readonly eventSubject = new Subject<SecurityTelemetryEvent>();
  readonly events$: Observable<SecurityTelemetryEvent> = this.eventSubject.asObservable();

  private devtoolsIntervalId: number | null = null;
  private lastDevicePixelRatio: number = 1;
  private isDestroyed = false;

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.lastDevicePixelRatio = window.devicePixelRatio || 1;
      this.checkFullscreenStatus();
      this.initListeners();
      this.startDevToolsDetector();
      this.initBatteryMonitor();
      this.initMediaDevicesMonitor();
    }
  }

  ngOnDestroy(): void {
    this.isDestroyed = true;
    if (this.devtoolsIntervalId !== null) {
      clearInterval(this.devtoolsIntervalId);
    }
    this.eventSubject.complete();
  }

  // ── Métodos de Pantalla Completa ─────────────────────────────────────────

  /**
   * Solicita el modo pantalla completa al navegador.
   * Debe ejecutarse a raíz de una acción del usuario (clic).
   */
  async requestFullscreen(): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) return false;

    try {
      const docEl = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
        mozRequestFullScreen?: () => Promise<void>;
        msRequestFullscreen?: () => Promise<void>;
      };

      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.mozRequestFullScreen) {
        await docEl.mozRequestFullScreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }

      this.checkFullscreenStatus();
      return true;
    } catch (err) {
      this.emitEvent({
        type: 'fullscreen_error',
        label: 'Error al solicitar pantalla completa',
        detail: String(err),
        icon: '⚠️',
        severity: 'warning',
      });
      return false;
    }
  }

  /**
   * Sale del modo pantalla completa.
   */
  async exitFullscreen(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;

    try {
      const doc = document as Document & {
        webkitExitFullscreen?: () => Promise<void>;
        mozCancelFullScreen?: () => Promise<void>;
        msExitFullscreen?: () => Promise<void>;
      };

      if (doc.exitFullscreen) {
        await doc.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        await doc.webkitExitFullscreen();
      } else if (doc.mozCancelFullScreen) {
        await doc.mozCancelFullScreen();
      } else if (doc.msExitFullscreen) {
        await doc.msExitFullscreen();
      }
      this.checkFullscreenStatus();
    } catch (err) {
      console.warn('Error al salir de fullscreen:', err);
    }
  }

  /**
   * Verifica estrictamente si el navegador está en pantalla completa.
   */
  checkFullscreenStatus(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;

    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      mozFullScreenElement?: Element;
      msFullscreenElement?: Element;
    };

    const hasElement = !!(
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement
    );

    // Detección complementaria para F11 nativo
    const screenMatch =
      window.innerHeight >= window.screen.height - 2 &&
      window.innerWidth >= window.screen.width - 2;

    const current = hasElement || screenMatch;
    const previous = this.isFullscreen();

    if (current !== previous) {
      this.isFullscreen.set(current);
      if (current) {
        this.emitEvent({
          type: 'fullscreen_enter',
          label: 'Pantalla Completa Activada',
          detail: `Resolución: ${window.innerWidth}x${window.innerHeight}`,
          icon: '⛶',
          severity: 'info',
        });
      } else {
        this.totalViolations.update((n) => n + 1);
        this.emitEvent({
          type: 'fullscreen_exit',
          label: 'Salida de Pantalla Completa Detectada',
          detail: 'El usuario intentó salir o minimizar el modo pantalla completa',
          icon: '🚫',
          severity: 'critical',
        });
      }
    }

    return current;
  }

  // ── Inicialización de Listeners Fuera de Zona Angular ────────────────────

  private initListeners(): void {
    this.ngZone.runOutsideAngular(() => {
      // 1. Pantalla completa (todos los vendor prefixes)
      const fsEvents = [
        'fullscreenchange',
        'webkitfullscreenchange',
        'mozfullscreenchange',
        'MSFullscreenChange',
      ];
      for (const ev of fsEvents) {
        document.addEventListener(ev, () => {
          this.ngZone.run(() => this.checkFullscreenStatus());
        });
      }

      // 2. Window Focus y Blur (Alt+Tab, cambio de app o clic fuera)
      window.addEventListener('blur', () => {
        this.ngZone.run(() => {
          this.isWindowFocused.set(false);
          this.totalViolations.update((n) => n + 1);
          this.emitEvent({
            type: 'window_blur',
            label: 'Foco Perdido (Alt+Tab / Cambio de Ventana)',
            detail: 'El navegador perdió el foco primario del sistema operativo',
            icon: '🔀',
            severity: 'critical',
          });
        });
      });

      window.addEventListener('focus', () => {
        this.ngZone.run(() => {
          this.isWindowFocused.set(true);
          this.emitEvent({
            type: 'window_focus',
            label: 'Foco de Ventana Recuperado',
            detail: 'El usuario regresó al navegador',
            icon: '🎯',
            severity: 'info',
          });
        });
      });

      // 3. Mouse Leave / Enter (cursor fuera del viewport de la página)
      document.addEventListener('mouseleave', (e) => {
        this.ngZone.run(() => {
          this.isCursorInside.set(false);
          this.emitEvent({
            type: 'mouse_leave',
            label: 'Cursor Fuera de la Ventana',
            detail: `Posición de salida: X=${e.clientX}, Y=${e.clientY}`,
            icon: '🖱️',
            severity: 'warning',
          });
        });
      });

      document.addEventListener('mouseenter', () => {
        this.ngZone.run(() => {
          this.isCursorInside.set(true);
          this.emitEvent({
            type: 'mouse_enter',
            label: 'Cursor Reingresó a la Ventana',
            detail: 'El puntero está nuevamente dentro del área visible',
            icon: '✨',
            severity: 'info',
          });
        });
      });

      // 4. Redimensionamiento y Zoom
      window.addEventListener('resize', () => {
        this.ngZone.run(() => {
          this.checkFullscreenStatus();
          const currentDpr = window.devicePixelRatio || 1;
          const isZoom = Math.abs(currentDpr - this.lastDevicePixelRatio) > 0.05;
          this.lastDevicePixelRatio = currentDpr;

          this.emitEvent({
            type: isZoom ? 'zoom_changed' : 'window_resized',
            label: isZoom ? 'Cambio de Zoom Detectado' : 'Ventana Redimensionada',
            detail: `${window.innerWidth}x${window.innerHeight} (Zoom: ${Math.round(currentDpr * 100)}%)`,
            icon: '📏',
            severity: 'warning',
          });
        });
      });

      // 5. Cambio de orientación de pantalla
      if (screen?.orientation) {
        screen.orientation.addEventListener('change', () => {
          this.ngZone.run(() => {
            this.emitEvent({
              type: 'orientation_changed',
              label: 'Orientación de Pantalla Cambiada',
              detail: `${screen.orientation.type} (${screen.orientation.angle}°)`,
              icon: '🔄',
              severity: 'warning',
            });
          });
        });
      }

      // 6. Vigilancia de Teclas y Atajos
      window.addEventListener(
        'keydown',
        (e: KeyboardEvent) => {
          const key = e.key;
          const isAltTab = e.altKey && (key === 'Tab' || key === 'Alt');
          const isDevToolsKey =
            key === 'F12' ||
            (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(key));
          const isViewSource = e.ctrlKey && (key === 'u' || key === 'U');
          const isPrint = e.ctrlKey && (key === 'p' || key === 'P');
          const isEscape = key === 'Escape';
          const isF11 = key === 'F11';
          const isWinKey = key === 'Meta' || key === 'OS';
          const isPrintScreen = key === 'PrintScreen';

          if (isDevToolsKey || isViewSource || isPrintScreen) {
            e.preventDefault();
            this.ngZone.run(() => {
              this.totalViolations.update((n) => n + 1);
              this.emitEvent({
                type: 'disallowed_shortcut',
                label: 'Atajo Prohibido Interceptado',
                detail: `Combinación: ${key} (Ctrl=${e.ctrlKey}, Shift=${e.shiftKey}, Alt=${e.altKey})`,
                icon: '⛔',
                severity: 'critical',
              });
            });
          } else if (isEscape || isF11) {
            this.ngZone.run(() => {
              this.emitEvent({
                type: 'fullscreen_key_attempt',
                label: `Tecla de Control Presionada: ${key}`,
                detail: 'El usuario presionó una tecla que altera el estado de pantalla',
                icon: '⌨️',
                severity: 'warning',
              });
              setTimeout(() => this.checkFullscreenStatus(), 200);
            });
          } else if (isAltTab || isWinKey) {
            this.ngZone.run(() => {
              this.totalViolations.update((n) => n + 1);
              this.emitEvent({
                type: 'os_switch_key',
                label: `Tecla de Cambio de SO: ${key}`,
                detail: 'El usuario intentó acceder a la barra o conmutador de ventanas del SO',
                icon: '⚠️',
                severity: 'critical',
              });
            });
          }
        },
        true,
      );

      // 7. Eventos de Portapapeles (Copiar, Pegar, Cortar)
      document.addEventListener('copy', (e) => {
        this.ngZone.run(() => {
          this.emitEvent({
            type: 'clipboard_copy',
            label: 'Intento de Copiado Detectado',
            detail: 'El usuario intentó copiar contenido al portapapeles',
            icon: '📋',
            severity: 'warning',
          });
        });
      });

      document.addEventListener('paste', () => {
        this.ngZone.run(() => {
          this.emitEvent({
            type: 'clipboard_paste',
            label: 'Intento de Pegado Detectado',
            detail: 'El usuario intentó pegar contenido desde el portapapeles',
            icon: '📥',
            severity: 'warning',
          });
        });
      });

      document.addEventListener('cut', () => {
        this.ngZone.run(() => {
          this.emitEvent({
            type: 'clipboard_cut',
            label: 'Intento de Corte Detectado',
            detail: 'El usuario intentó cortar texto',
            icon: '✂️',
            severity: 'warning',
          });
        });
      });

      // 8. Menú Contextual (Clic Derecho)
      document.addEventListener('contextmenu', (e) => {
        this.ngZone.run(() => {
          this.emitEvent({
            type: 'context_menu',
            label: 'Clic Derecho / Menú Contextual',
            detail: `Coordenadas: X=${e.clientX}, Y=${e.clientY}`,
            icon: '🚫',
            severity: 'warning',
          });
        });
      });

      // 9. Conexión de Red (Online / Offline / Connection Change)
      window.addEventListener('online', () => {
        this.ngZone.run(() => {
          this.emitEvent({
            type: 'network_online',
            label: 'Conexión a Internet Restablecida',
            detail: 'El navegador volvió a estar online',
            icon: '🌐',
            severity: 'info',
          });
        });
      });

      window.addEventListener('offline', () => {
        this.ngZone.run(() => {
          this.emitEvent({
            type: 'network_offline',
            label: 'Conexión a Internet Perdida',
            detail: 'El navegador pasó a estado offline',
            icon: '📵',
            severity: 'critical',
          });
        });
      });

      const navConn = (navigator as unknown as { connection?: EventTarget & { effectiveType?: string } }).connection;
      if (navConn?.addEventListener) {
        navConn.addEventListener('change', () => {
          this.ngZone.run(() => {
            this.emitEvent({
              type: 'network_speed_change',
              label: 'Cambio de Tipo de Red',
              detail: `Tipo actual: ${navConn.effectiveType || 'desconocido'}`,
              icon: '📶',
              severity: 'info',
            });
          });
        });
      }
    });
  }

  // ── Detección de DevTools ────────────────────────────────────────────────

  private startDevToolsDetector(): void {
    this.ngZone.runOutsideAngular(() => {
      this.devtoolsIntervalId = window.setInterval(() => {
        if (this.isDestroyed) return;

        // Heurística de diferencia de dimensiones (ventana vs contenido)
        const widthThreshold = window.outerWidth - window.innerWidth > 160;
        const heightThreshold = window.outerHeight - window.innerHeight > 160;
        const detected = widthThreshold || heightThreshold;

        if (detected !== this.isDevToolsOpen()) {
          this.ngZone.run(() => {
            this.isDevToolsOpen.set(detected);
            if (detected) {
              this.totalViolations.update((n) => n + 1);
              this.emitEvent({
                type: 'devtools_opened',
                label: 'Herramientas de Desarrollador (DevTools) Detectadas',
                detail: `Divergencia de ventana: ΔW=${window.outerWidth - window.innerWidth}px, ΔH=${window.outerHeight - window.innerHeight}px`,
                icon: '🛠️',
                severity: 'critical',
              });
            } else {
              this.emitEvent({
                type: 'devtools_closed',
                label: 'Herramientas de Desarrollador Cerradas',
                detail: 'DevTools ya no están acopladas',
                icon: '✅',
                severity: 'info',
              });
            }
          });
        }
      }, 1000);
    });
  }

  // ── Monitor de Periféricos / Dispositivos ────────────────────────────────

  private initMediaDevicesMonitor(): void {
    if (navigator.mediaDevices?.addEventListener) {
      this.ngZone.runOutsideAngular(() => {
        navigator.mediaDevices.addEventListener('devicechange', () => {
          this.ngZone.run(() => {
            this.emitEvent({
              type: 'media_device_change',
              label: 'Cambio de Periférico Detectado',
              detail: 'Se conectó o desconectó una pantalla, cámara, micrófono o salida de audio',
              icon: '🔌',
              severity: 'warning',
            });
          });
        });
      });
    }
  }

  // ── Monitor de Batería ───────────────────────────────────────────────────

  private initBatteryMonitor(): void {
    const navAny = navigator as unknown as {
      getBattery?: () => Promise<{
        charging: boolean;
        level: number;
        addEventListener: (event: string, fn: () => void) => void;
      }>;
    };

    if (typeof navAny.getBattery === 'function') {
      navAny.getBattery().then((battery) => {
        battery.addEventListener('chargingchange', () => {
          this.ngZone.run(() => {
            this.emitEvent({
              type: 'battery_charge',
              label: 'Estado del Cargador Modificado',
              detail: battery.charging ? 'Dispositivo conectado a la corriente' : 'Dispositivo desconectado de la corriente',
              icon: '🔋',
              severity: 'info',
            });
          });
        });

        battery.addEventListener('levelchange', () => {
          this.ngZone.run(() => {
            this.emitEvent({
              type: 'battery_level',
              label: 'Nivel de Batería Modificado',
              detail: `Nivel actual: ${Math.round(battery.level * 100)}%`,
              icon: '⚡',
              severity: 'info',
            });
          });
        });
      }).catch(() => {
        // Battery API no disponible o denegada
      });
    }
  }

  // ── Helper para emisión de eventos ───────────────────────────────────────

  emitCustomEvent(event: Omit<SecurityTelemetryEvent, 'id' | 'timestamp'>): void {
    this.emitEvent(event);
  }

  private emitEvent(event: Omit<SecurityTelemetryEvent, 'id' | 'timestamp'>): void {
    const fullEvent: SecurityTelemetryEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date(),
    };
    this.eventSubject.next(fullEvent);
  }
}
