/**
 * @file visibility-monitor.component.ts
 * @description Dashboard empresarial de monitoreo de actividad, telemetría y seguridad.
 *
 * Características:
 *  - Bloqueo estricto por Pantalla Completa: Si no está en fullscreen, la pantalla queda bloqueada ("si no es asi no se puede").
 *  - Integración nativa de WebGL con Canvas 3D y GLSL Shaders reactivos al estado del sistema.
 *  - Detección heurística avanzada de Máquinas Virtuales (VMware, VirtualBox, QEMU, SwiftShader, etc.).
 *  - Detección integral de eventos del navegador:
 *     - Foco/Desenfoque de ventana (Alt+Tab)
 *     - Salida de cursor del área visible (mouseleave)
 *     - Detección de DevTools abiertas
 *     - Intercepción de atajos y teclas (F11, F12, Escape, WinKey, Ctrl+Shift+I, etc.)
 *     - Portapapeles (Copiar, Pegar, Cortar) y Menú Contextual (clic derecho)
 *     - Redimensionamiento y cambios de Zoom
 *     - Conexión/Desconexión de periféricos (monitores, audio, webcams)
 *     - Estado de batería y red
 *     - Pérdida/Restauración de contexto WebGL
 *  - UI con OnPush + Angular Signals.
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
import { ActivityState } from '../../core/services/browser-activity.model';
import { SecurityTelemetryEvent } from '../../core/services/security-telemetry.service';
import { WebglCanvasComponent } from './components/webgl-canvas/webgl-canvas.component';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos
// ─────────────────────────────────────────────────────────────────────────────

type FeedItemSeverity = 'info' | 'warning' | 'critical';

interface UnifiedFeedEntry {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: string;
  readonly severity: FeedItemSeverity;
  readonly timestamp: Date;
}

@Component({
  selector: 'app-visibility-monitor',
  standalone: true,
  imports: [DatePipe, NgClass, WebglCanvasComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- ══════════════════════════════════════════════
         GATE: BLOQUEO ESTRICTO POR PANTALLA COMPLETA
         "si no es asi no se puede"
    ══════════════════════════════════════════════ -->
    @if (!isFullscreen()) {
      <div class="fullscreen-gate" role="alertdialog" aria-modal="true">
        <div class="gate-card">
          <div class="gate-lock-pulse">
            <span class="gate-icon">🔒</span>
          </div>

          <h2 class="gate-title">ACCESO BLOQUEADO</h2>
          <span class="gate-subtitle">PANTALLA COMPLETA OBLIGATORIA</span>

          <p class="gate-desc">
            Para garantizar la integridad y seguridad del monitoreo en tiempo real,
            <strong>no se puede utilizar ni visualizar el sistema</strong> fuera del modo pantalla completa.
          </p>

          <div class="gate-reasons">
            <div class="reason-row">
              <span class="reason-bullet">⛔</span>
              <span>Interfaz y funciones bloqueadas automáticamente.</span>
            </div>
            <div class="reason-row">
              <span class="reason-bullet">⚠️</span>
              <span>Cualquier salida de pantalla completa genera un registro de violación.</span>
            </div>
            <div class="reason-row">
              <span class="reason-bullet">🛡️</span>
              <span>Vigilancia activa de hardware, GPU WebGL y periféricos.</span>
            </div>
          </div>

          <button
            type="button"
            class="gate-cta-btn"
            (click)="requestFullscreen()"
          >
            <span class="cta-icon">⛶</span>
            ACTIVAR PANTALLA COMPLETA Y DESBLOQUEAR
          </button>

          <div class="gate-status-tag">
            ESTADO ACTUAL: VENTANA CONVENCIONAL O MINIMIZADA (BLOQUEADO)
          </div>
        </div>
      </div>
    }

    <!-- ══════════════════════════════════════════════
         DASHBOARD PRINCIPAL (DESBLOQUEADO EN FULLSCREEN)
    ══════════════════════════════════════════════ -->
    <div class="dashboard" [ngClass]="{ 'dash--alert': isGlobalAlert() }">

      <!-- ── HEADER ── -->
      <header class="dash-header">
        <div class="dash-brand">
          <span class="dash-logo">🛡️</span>
          <div>
            <h1>Security & Sentinel Monitor</h1>
            <span class="dash-session">Session: {{ sessionId }}</span>
          </div>
        </div>

        <div class="dash-header-right">
          <!-- Botón / Indicador de Pantalla Completa -->
          <button
            type="button"
            class="fs-indicator-btn"
            [ngClass]="isFullscreen() ? 'fs--active' : 'fs--inactive'"
            (click)="toggleFullscreen()"
          >
            <span class="fs-dot"></span>
            {{ isFullscreen() ? '⛶ PANTALLA COMPLETA' : '⚠️ SALIR BLOQUEARÁ' }}
          </button>

          <!-- Nivel de atención -->
          <span class="attention-badge" [ngClass]="attentionClass()">
            {{ attentionLabel() }}
          </span>
        </div>
      </header>

      <!-- ── ALERTA DE MÁQUINA VIRTUAL SI SE DETECTA ── -->
      @if (vmReport().isVm) {
        <div class="vm-banner vm-banner--critical">
          <span class="vm-banner-icon">🚨</span>
          <div class="vm-banner-text">
            <strong>MÁQUINA VIRTUAL DETECTADA:</strong>
            {{ vmReport().detectedHypervisor || vmReport().unmaskedRenderer }}
            (Nivel de Confianza: {{ vmReport().confidenceScore }}%)
          </div>
          <span class="vm-banner-tag">AISLAMIENTO ACTIVO</span>
        </div>
      } @else if (vmReport().riskLevel === 'SUSPICIOUS') {
        <div class="vm-banner vm-banner--warning">
          <span class="vm-banner-icon">⚠️</span>
          <div class="vm-banner-text">
            <strong>ENTORNO SOSPECHOSO:</strong>
            Posible contenedor o máquina virtual ligera (Riesgo: {{ vmReport().confidenceScore }}%)
          </div>
        </div>
      }

      <!-- ── WEBGL 3D CANVAS Y SUB-SISTEMA GPU ── -->
      <section class="webgl-section">
        <app-webgl-canvas [alertMode]="isGlobalAlert()" />
      </section>

      <!-- ── STATUS PILLARS (6 PILARES DE SEGURIDAD Y ESTADO) ── -->
      <section class="pillars-grid">

        <!-- 1. Pantalla Completa -->
        <div class="pillar" [ngClass]="fullscreenClass()">
          <div class="pillar-icon">{{ isFullscreen() ? '⛶' : '🔒' }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Pantalla Completa</span>
            <span class="pillar-value">{{ isFullscreen() ? 'ACTIVA' : 'BLOQUEADA' }}</span>
            <span class="pillar-sub">{{ isFullscreen() ? 'Modo Seguro' : 'Bloqueado' }}</span>
          </div>
        </div>

        <!-- 2. Detección VM -->
        <div class="pillar" [ngClass]="vmClass()">
          <div class="pillar-icon">{{ vmReport().isVm ? '🤖' : '💻' }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Entorno SO</span>
            <span class="pillar-value">
              {{ vmReport().isVm ? 'VM DETECTADA' : (vmReport().riskLevel === 'SUSPICIOUS' ? 'SOSPECHOSO' : 'FÍSICO') }}
            </span>
            <span class="pillar-sub">
              {{ vmReport().detectedHypervisor ? vmReport().detectedHypervisor : 'Host Físico' }}
            </span>
          </div>
        </div>

        <!-- 3. Integridad / DevTools -->
        <div class="pillar" [ngClass]="integrityClass()">
          <div class="pillar-icon">{{ isDevToolsOpen() ? '🛠️' : (!isWindowFocused() ? '🔀' : '🛡️') }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Integridad</span>
            <span class="pillar-value">
              {{ isDevToolsOpen() ? 'DEVTOOLS ON' : (!isWindowFocused() ? 'FOCO PERDIDO' : 'INTEGRO') }}
            </span>
            <span class="pillar-sub">{{ totalViolations() }} violaciones</span>
          </div>
        </div>

        <!-- 4. Pestaña / Visibilidad -->
        <div class="pillar" [ngClass]="visibilityClass()">
          <div class="pillar-icon">{{ visibilityIcon() }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Pestaña</span>
            <span class="pillar-value">{{ currentState()?.visibility?.isTabActive ? 'ACTIVA' : 'INACTIVA' }}</span>
            <span class="pillar-sub">{{ currentState()?.visibility?.visibilityState ?? '—' }}</span>
          </div>
        </div>

        <!-- 5. Actividad / Idle -->
        <div class="pillar" [ngClass]="idleClass()">
          <div class="pillar-icon">{{ idleIcon() }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Usuario</span>
            <span class="pillar-value">{{ currentState()?.idle?.status === 'active' ? 'ACTIVO' : 'INACTIVO' }}</span>
            <span class="pillar-sub">{{ currentState()?.idle?.lastActivityEvent ?? 'sin actividad' }}</span>
          </div>
        </div>

        <!-- 6. Red -->
        <div class="pillar" [ngClass]="networkClass()">
          <div class="pillar-icon">{{ networkIcon() }}</div>
          <div class="pillar-body">
            <span class="pillar-label">Red</span>
            <span class="pillar-value">{{ currentState()?.network?.isOnline ? 'ONLINE' : 'OFFLINE' }}</span>
            <span class="pillar-sub">{{ currentState()?.network?.effectiveType ?? 'LAN/WIFI' }}</span>
          </div>
        </div>

      </section>

      <!-- ── HARDWARE & VM FORENSICS ACCORDION ── -->
      <section class="forensics-section">
        <div class="forensics-header" (click)="toggleForensics()">
          <div class="forensics-title">
            <span>🔬</span>
            <span>Diagnóstico Forense de Hardware & Máquina Virtual</span>
          </div>
          <button type="button" class="btn-recheck" (click)="recheckEnvironment($event)">
            🔄 Re-analizar Entorno
          </button>
        </div>

        <div class="forensics-body">
          <div class="forensics-grid">
            <div class="f-item">
              <span class="f-key">HIPERVISOR:</span>
              <span class="f-val" [ngClass]="vmReport().isVm ? 'f-val--alert' : ''">
                {{ vmReport().detectedHypervisor || 'Ninguno (Físico)' }}
              </span>
            </div>
            <div class="f-item">
              <span class="f-key">CONFIANZA VM:</span>
              <span class="f-val" [ngClass]="vmReport().confidenceScore > 50 ? 'f-val--alert' : ''">
                {{ vmReport().confidenceScore }}%
              </span>
            </div>
            <div class="f-item">
              <span class="f-key">GPU UNMASKED:</span>
              <span class="f-val">{{ vmReport().unmaskedRenderer }}</span>
            </div>
            <div class="f-item">
              <span class="f-key">CPU CORES:</span>
              <span class="f-val">{{ vmReport().hardwareConcurrency }} vCPUs</span>
            </div>
            <div class="f-item">
              <span class="f-key">RAM DISPOSITIVO:</span>
              <span class="f-val">{{ vmReport().deviceMemoryGb ? vmReport().deviceMemoryGb + ' GB' : 'No reportada' }}</span>
            </div>
            <div class="f-item">
              <span class="f-key">WEBDRIVER AUTO:</span>
              <span class="f-val" [ngClass]="vmReport().isWebDriver ? 'f-val--alert' : ''">
                {{ vmReport().isWebDriver ? 'DETECTADO (ALERTA)' : 'Limpio' }}
              </span>
            </div>
            <div class="f-item full-width">
              <span class="f-key">RESOLUCIÓN & COLOR:</span>
              <span class="f-val">{{ vmReport().screenMetrics }}</span>
            </div>
          </div>

          @if (vmReport().riskFactors.length > 0) {
            <div class="risk-factors-box">
              <span class="risk-factors-title">Hallazgos y Factores de Riesgo:</span>
              <ul class="risk-list">
                @for (factor of vmReport().riskFactors; track factor) {
                  <li>⚠️ {{ factor }}</li>
                }
              </ul>
            </div>
          }
        </div>
      </section>

      <!-- ── STATS ROW ── -->
      <section class="stats-row">
        <div class="stat">
          <span class="stat-value">{{ sessionDuration() }}</span>
          <span class="stat-label">Duración</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ feedEntries().length }}</span>
          <span class="stat-label">Eventos</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ totalViolations() }}</span>
          <span class="stat-label">Violaciones</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ queueSize() }}</span>
          <span class="stat-label">Cola Auditoría</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ sentBatches() }}</span>
          <span class="stat-label">Batches</span>
        </div>
      </section>

      <!-- ── UNIFIED REAL-TIME EVENT FEED ── -->
      <section class="feed-section">
        <div class="feed-header">
          <div class="feed-title-wrapper">
            <span class="feed-title">Feed de Telemetría Global en Tiempo Real</span>
            <span class="feed-badge">Vigilancia Absoluta Activa</span>
          </div>
          <span class="feed-count">{{ feedEntries().length }} / {{ maxFeedItems }}</span>
        </div>

        @if (feedEntries().length === 0) {
          <div class="feed-empty">
            <span>🕐</span>
            <p>Monitoreando activamente todos los eventos del navegador y el sistema...</p>
          </div>
        } @else {
          <ul class="feed-list" role="log" aria-live="polite">
            @for (entry of feedEntries(); track entry.id) {
              <li class="feed-item" [ngClass]="'feed-sev--' + entry.severity">
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
                  [ngClass]="{
                    'dot--green': entry.severity === 'info',
                    'dot--amber': entry.severity === 'warning',
                    'dot--red': entry.severity === 'critical'
                  }"
                ></span>
              </li>
            }
          </ul>
        }
      </section>

      <!-- ── FOOTER ── -->
      <footer class="dash-footer">
        <span>🔒 Detectando: WebGL · VM · Pantalla Completa · DevTools · Atajos · Foco · Cursor · Periféricos · Red</span>
        <span class="footer-hint">Iniciado {{ sessionStart | date: 'HH:mm:ss' }}</span>
      </footer>

    </div>
  `,
  styles: [`
    :host {
      display: block;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #060911;
      min-height: 100vh;
      color: #e2e8f0;
      padding: 1rem 0;
    }

    /* ════════════════════════════════════════════════════════
       FULLSCREEN LOCKOUT GATE OVERLAY ("si no es asi no se puede")
    ════════════════════════════════════════════════════════ */
    .fullscreen-gate {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(3, 7, 18, 0.96);
      backdrop-filter: blur(28px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      animation: fadeIn .25s ease;
    }

    .gate-card {
      max-width: 540px;
      width: 100%;
      background: #0f172a;
      border: 2px solid #ef4444;
      border-radius: 20px;
      padding: 2.5rem 2rem;
      text-align: center;
      box-shadow: 0 0 60px rgba(239, 68, 68, 0.35);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.25rem;
    }

    .gate-lock-pulse {
      position: relative;
      width: 80px;
      height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(239, 68, 68, 0.15);
      border-radius: 50%;
      border: 2px solid #ef4444;
    }

    .gate-icon { font-size: 2.5rem; }

    .gate-title {
      margin: 0;
      font-size: 1.6rem;
      font-weight: 900;
      letter-spacing: 0.08em;
      color: #f87171;
    }

    .gate-subtitle {
      font-size: 0.8rem;
      font-weight: 800;
      letter-spacing: 0.15em;
      color: #94a3b8;
      text-transform: uppercase;
      margin-top: -0.75rem;
    }

    .gate-desc {
      font-size: 0.9rem;
      line-height: 1.5;
      color: #cbd5e1;
    }

    .gate-reasons {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      width: 100%;
      background: #1e293b;
      padding: 1rem 1.25rem;
      border-radius: 12px;
      border: 1px solid #334155;
      text-align: left;
      font-size: 0.8rem;
      color: #94a3b8;
    }

    .reason-row {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .reason-bullet { font-size: 1rem; }

    .gate-cta-btn {
      width: 100%;
      padding: 1rem 1.5rem;
      background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
      color: #ffffff;
      border: none;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      box-shadow: 0 4px 20px rgba(239, 68, 68, 0.5);
      transition: transform .15s, box-shadow .15s;
    }

    .gate-cta-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(239, 68, 68, 0.7);
    }

    .cta-icon { font-size: 1.25rem; }

    .gate-status-tag {
      font-size: 0.7rem;
      font-family: monospace;
      color: #ef4444;
      font-weight: 700;
      letter-spacing: 0.05em;
    }

    /* ════════════════════════════════════════════════════════
       DASHBOARD
    ════════════════════════════════════════════════════════ */
    .dashboard {
      max-width: 900px;
      margin: 0 auto;
      background: #0f172a;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 12px 60px rgba(0,0,0,0.6);
      border: 1px solid #1e293b;
      transition: border-color .3s;
    }

    .dashboard.dash--alert {
      border-color: #ef4444;
    }

    /* ── Header ── */
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
    .dash-brand h1 { margin: 0; font-size: 1.05rem; font-weight: 800; color: #f1f5f9; }
    .dash-session  { font-size: .68rem; color: #64748b; font-family: monospace; }

    .dash-header-right { display: flex; align-items: center; gap: .75rem; }

    .fs-indicator-btn {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.72rem;
      font-weight: 800;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      border: none;
      cursor: pointer;
    }

    .fs--active {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }

    .fs--inactive {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
    }

    .fs-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }

    .attention-badge {
      font-size: .75rem; font-weight: 800; letter-spacing: .06em;
      padding: .25rem .75rem; border-radius: 999px;
    }
    .att--full    { background: #166534; color: #4ade80; }
    .att--partial { background: #713f12; color: #fbbf24; }
    .att--none    { background: #7f1d1d; color: #f87171; }

    /* ── VM Banner ── */
    .vm-banner {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.85rem 1.25rem;
      font-size: 0.82rem;
    }
    .vm-banner--critical {
      background: rgba(239, 68, 68, 0.2);
      border-bottom: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .vm-banner--warning {
      background: rgba(245, 158, 11, 0.2);
      border-bottom: 1px solid rgba(245, 158, 11, 0.4);
      color: #fde68a;
    }
    .vm-banner-icon { font-size: 1.25rem; }
    .vm-banner-text { flex: 1; }
    .vm-banner-tag {
      font-size: 0.65rem;
      font-weight: 800;
      background: #b91c1c;
      color: #ffffff;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      letter-spacing: 0.08em;
    }

    /* ── WebGL Section ── */
    .webgl-section {
      padding: 1.25rem 1.25rem 0.5rem 1.25rem;
    }

    /* ── Pillars Grid ── */
    .pillars-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      background: #334155;
      border-top: 1px solid #334155;
      border-bottom: 1px solid #334155;
    }

    .pillar {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      padding: 1rem 1.25rem;
      background: #1e293b;
      transition: background .2s;
    }
    .pillar-icon { font-size: 1.8rem; }
    .pillar-body { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
    .pillar-label { font-size: .65rem; text-transform: uppercase; letter-spacing: .08em; color: #64748b; font-weight: 700; }
    .pillar-value { font-size: .88rem; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pillar-sub   { font-size: .68rem; color: #94a3b8; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .pillar--ok     .pillar-value { color: #4ade80; }
    .pillar--warn   .pillar-value { color: #fbbf24; }
    .pillar--danger .pillar-value { color: #f87171; }

    /* ── Forensics Section ── */
    .forensics-section {
      background: #0d1527;
      border-bottom: 1px solid #1e293b;
    }

    .forensics-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.25rem;
      background: #162032;
      border-bottom: 1px solid #1e293b;
      cursor: pointer;
    }

    .forensics-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
    }

    .btn-recheck {
      background: #1e293b;
      border: 1px solid #334155;
      color: #38bdf8;
      border-radius: 6px;
      padding: 0.25rem 0.6rem;
      font-size: 0.68rem;
      font-weight: 600;
      cursor: pointer;
    }

    .forensics-body {
      padding: 1rem 1.25rem;
    }

    .forensics-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.6rem;
      font-family: monospace;
      font-size: 0.7rem;
    }

    .f-item {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      background: #141e30;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      border: 1px solid #1e293b;
      overflow: hidden;
    }

    .f-item.full-width {
      grid-column: span 3;
    }

    .f-key { color: #64748b; font-size: 0.62rem; font-weight: 700; }
    .f-val { color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .f-val--alert { color: #f87171; font-weight: 800; }

    .risk-factors-box {
      margin-top: 0.75rem;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 6px;
      padding: 0.6rem 0.85rem;
      font-size: 0.72rem;
    }

    .risk-factors-title {
      font-weight: 700;
      color: #f87171;
      display: block;
      margin-bottom: 0.35rem;
    }

    .risk-list {
      margin: 0;
      padding-left: 1.2rem;
      color: #fca5a5;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    /* ── Stats Row ── */
    .stats-row {
      display: flex;
      border-bottom: 1px solid #1e293b;
    }
    .stat {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: .8rem .4rem;
      border-right: 1px solid #1e293b;
      gap: .15rem;
    }
    .stat:last-child { border-right: none; }
    .stat-value { font-size: 1.25rem; font-weight: 800; color: #f1f5f9; font-variant-numeric: tabular-nums; }
    .stat-label { font-size: .62rem; text-transform: uppercase; letter-spacing: .08em; color: #64748b; font-weight: 700; }

    /* ── Event Feed ── */
    .feed-section { padding: 1rem 1.25rem; }
    .feed-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: .75rem;
    }
    .feed-title-wrapper {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .feed-title { font-size: .78rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .08em; }
    .feed-badge {
      font-size: 0.62rem;
      font-weight: 700;
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
    }
    .feed-count { font-size: .7rem; color: #475569; font-family: monospace; }

    .feed-empty {
      display: flex; align-items: center; gap: .75rem;
      padding: 1.25rem; border-radius: 8px;
      background: #1e293b; color: #475569; font-size: .82rem;
    }
    .feed-empty span { font-size: 1.5rem; }

    .feed-list {
      list-style: none; margin: 0; padding: 0;
      display: flex; flex-direction: column; gap: .35rem;
      max-height: 280px; overflow-y: auto;
    }
    .feed-list::-webkit-scrollbar { width: 4px; }
    .feed-list::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

    .feed-item {
      display: flex; align-items: center; gap: .6rem;
      padding: .45rem .75rem; border-radius: 6px;
      background: #1e293b;
      animation: slideIn .2s ease;
      transition: background .2s;
    }
    .feed-item:hover { background: #263548; }

    .feed-sev--info     { border-left: 2px solid #38bdf8; }
    .feed-sev--warning  { border-left: 2px solid #f59e0b; }
    .feed-sev--critical { border-left: 2px solid #ef4444; background: rgba(239, 68, 68, 0.12); }

    .fi-icon   { font-size: 1rem; min-width: 1.5rem; text-align: center; }
    .fi-body   { flex: 1; display: flex; flex-direction: column; gap: .05rem; min-width: 0; }
    .fi-label  { font-size: .76rem; font-weight: 700; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fi-detail { font-size: .66rem; color: #94a3b8; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fi-time   { font-size: .66rem; color: #475569; font-family: monospace; white-space: nowrap; }

    .fi-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .dot--green { background: #4ade80; }
    .dot--amber { background: #fbbf24; }
    .dot--red   { background: #f87171; }

    /* ── Footer ── */
    .dash-footer {
      display: flex; justify-content: space-between; align-items: center;
      padding: .65rem 1.25rem;
      background: #1e293b; border-top: 1px solid #334155;
      font-size: .68rem; color: #475569;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-8px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    @media (max-width: 700px) {
      .pillars-grid { grid-template-columns: 1fr; }
      .forensics-grid { grid-template-columns: 1fr; }
      .f-item.full-width { grid-column: span 1; }
      .stats-row { flex-wrap: wrap; }
      .stat { min-width: 33.3%; }
    }
  `],
})
export class VisibilityMonitorComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly facade = inject(BrowserActivityFacade);

  readonly maxFeedItems = 30;

  // ── Signals de estado ───────────────────────────────────────────────────
  readonly currentState = signal<ActivityState | null>(null);
  readonly feedEntries = signal<UnifiedFeedEntry[]>([]);
  readonly queueSize = signal<number>(0);
  readonly sentBatches = signal<number>(0);
  readonly sessionDuration = signal<string>('00:00:00');
  readonly forensicsExpanded = signal<boolean>(true);

  // Exponer signals de telemetría y VM desde la fachada
  readonly vmReport = this.facade.vmReport;
  readonly isFullscreen = this.facade.isFullscreen;
  readonly isWindowFocused = this.facade.isWindowFocused;
  readonly isDevToolsOpen = this.facade.isDevToolsOpen;
  readonly totalViolations = this.facade.totalViolations;

  readonly sessionId = this.facade.getSessionStats().sessionId;
  readonly sessionStart = this.facade.getSessionStats().startedAt;

  // ── Computed Signals ────────────────────────────────────────────────────

  readonly isGlobalAlert = computed(() => {
    return (
      !this.isFullscreen() ||
      this.vmReport().isVm ||
      this.isDevToolsOpen() ||
      !this.isWindowFocused() ||
      this.currentState()?.attentionLevel === 'none'
    );
  });

  readonly attentionLabel = computed(() => {
    if (!this.isFullscreen()) return '🔒 ACCESO BLOQUEADO';
    if (this.vmReport().isVm) return '🚨 ENTORNO VM AISLADO';
    const level = this.currentState()?.attentionLevel;
    return level === 'full'
      ? '● ATENCIÓN TOTAL'
      : level === 'partial'
        ? '◑ ATENCIÓN PARCIAL'
        : '○ SIN ATENCIÓN';
  });

  readonly attentionClass = computed(() => {
    if (!this.isFullscreen() || this.vmReport().isVm) return 'att--none';
    const level = this.currentState()?.attentionLevel;
    return level === 'full' ? 'att--full' : level === 'partial' ? 'att--partial' : 'att--none';
  });

  readonly fullscreenClass = computed(() =>
    this.isFullscreen() ? 'pillar--ok' : 'pillar--danger',
  );

  readonly vmClass = computed(() => {
    if (this.vmReport().isVm) return 'pillar--danger';
    if (this.vmReport().riskLevel === 'SUSPICIOUS') return 'pillar--warn';
    return 'pillar--ok';
  });

  readonly integrityClass = computed(() => {
    if (this.isDevToolsOpen() || !this.isWindowFocused()) return 'pillar--danger';
    return 'pillar--ok';
  });

  readonly visibilityClass = computed(() => {
    const v = this.currentState()?.visibility;
    if (!v) return 'pillar--warn';
    return v.isTabActive && v.visibilityState === 'visible' ? 'pillar--ok' : 'pillar--danger';
  });

  readonly visibilityIcon = computed(() =>
    this.currentState()?.visibility?.isTabActive ? '👁️' : '🙈',
  );

  readonly idleClass = computed(() =>
    this.currentState()?.idle?.status === 'active' ? 'pillar--ok' : 'pillar--warn',
  );

  readonly idleIcon = computed(() =>
    this.currentState()?.idle?.status === 'active' ? '⚡' : '💤',
  );

  readonly networkClass = computed(() =>
    this.currentState()?.network?.isOnline ? 'pillar--ok' : 'pillar--danger',
  );

  readonly networkIcon = computed(() =>
    this.currentState()?.network?.isOnline ? '🌐' : '📵',
  );

  // ── Ciclo de Vida ────────────────────────────────────────────────────────

  ngOnInit(): void {
    // 1. Suscripción a eventos de seguridad y cambios del navegador
    this.facade.securityEvents$
      .pipe(
        tap((secEvent) => this.addSecurityFeedEntry(secEvent)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();

    // 2. Suscripción al estado unificado de actividad
    this.facade.activityState$
      .pipe(
        tap((state) => {
          this.currentState.set(state);
          this.addActivityFeedEntry(state);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();

    // 3. Cola pendiente de auditoría
    this.facade.queueSize$
      .pipe(
        tap((n) => this.queueSize.set(n)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();

    // 4. Refresco del contador de duración
    interval(1_000)
      .pipe(
        tap(() => {
          const stats = this.facade.getSessionStats();
          this.sessionDuration.set(this.formatDuration(stats.durationMs));
          this.sentBatches.set(stats.sentBatches);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  // ── Acciones de Usuario ──────────────────────────────────────────────────

  async requestFullscreen(): Promise<void> {
    await this.facade.requestFullscreen();
  }

  async toggleFullscreen(): Promise<void> {
    if (this.isFullscreen()) {
      await this.facade.exitFullscreen();
    } else {
      await this.facade.requestFullscreen();
    }
  }

  toggleForensics(): void {
    this.forensicsExpanded.update((v) => !v);
  }

  recheckEnvironment(e: Event): void {
    e.stopPropagation();
    const rep = this.facade.recheckEnvironment();
    const severity: FeedItemSeverity = rep.isVm ? 'critical' : rep.riskLevel === 'SUSPICIOUS' ? 'warning' : 'info';
    const entry: UnifiedFeedEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: 'Re-análisis de Entorno Ejecutado',
      detail: `Resultado: ${rep.riskLevel} (${rep.confidenceScore}% VM score)`,
      icon: '🔄',
      severity,
      timestamp: new Date(),
    };
    this.feedEntries.update((prev) => [entry, ...prev].slice(0, this.maxFeedItems));
  }

  // ── Helpers de Feed ──────────────────────────────────────────────────────

  private addSecurityFeedEntry(event: SecurityTelemetryEvent): void {
    const entry: UnifiedFeedEntry = {
      id: event.id,
      label: event.label,
      detail: event.detail,
      icon: event.icon,
      severity: event.severity,
      timestamp: event.timestamp,
    };

    this.feedEntries.update((prev) => [entry, ...prev].slice(0, this.maxFeedItems));
  }

  private addActivityFeedEntry(state: ActivityState): void {
    const vis = state.visibility;
    const idle = state.idle;
    const net = state.network;

    let label = 'Actividad Actualizada';
    let detail = '';
    let icon = '📊';
    let severity: FeedItemSeverity = state.attentionLevel === 'full' ? 'info' : 'warning';

    if (!net.isOnline) {
      label = 'Red Desconectada';
      detail = 'El navegador no tiene conexión activa';
      icon = '📵';
      severity = 'critical';
    } else if (!vis.isTabActive || vis.visibilityState === 'hidden') {
      label = vis.eventType === 'blur' ? 'Foco de Pestaña Perdido' : 'Pestaña Oculta';
      detail = `${vis.eventType} · ${vis.visibilityState}`;
      icon = '🙈';
      severity = 'critical';
    } else if (idle.status === 'idle') {
      label = 'Inactividad de Usuario Detectada';
      detail = `Sin interacción desde ${idle.idleSince?.toLocaleTimeString() ?? '—'}`;
      icon = '💤';
      severity = 'warning';
    } else if (vis.isTabActive && vis.visibilityState === 'visible') {
      label = vis.eventType === 'focus' ? 'Foco de Pestaña Activo' : 'Pestaña Visible';
      detail = `${vis.eventType} · visible`;
      icon = '👁️';
      severity = 'info';
    } else if (idle.status === 'active') {
      label = 'Interacción de Usuario';
      detail = idle.lastActivityEvent ?? 'actividad detectada';
      icon = '⚡';
      severity = 'info';
    }

    const entry: UnifiedFeedEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label,
      detail,
      icon,
      severity,
      timestamp: new Date(),
    };

    this.feedEntries.update((prev) => [entry, ...prev].slice(0, this.maxFeedItems));
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1_000);
    const h = Math.floor(totalSec / 3_600);
    const m = Math.floor((totalSec % 3_600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }
}
