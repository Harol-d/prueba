/**
 * @file browser-activity.config.ts
 * @description Token de inyección para configurar el sistema de monitoreo de actividad.
 *
 * Uso en app.config.ts:
 * ```ts
 * providers: [
 *   {
 *     provide: BROWSER_ACTIVITY_CONFIG,
 *     useValue: { idleTimeoutMs: 60_000, batchIntervalMs: 15_000 }
 *   }
 * ]
 * ```
 */

import { InjectionToken } from '@angular/core';

export interface BrowserActivityConfig {
  /**
   * Tiempo en ms sin actividad del usuario para considerarse "idle".
   * @default 30_000 (30 segundos)
   */
  idleTimeoutMs: number;

  /**
   * Intervalo en ms entre cada flush de batch al backend.
   * @default 10_000 (10 segundos)
   */
  batchIntervalMs: number;

  /**
   * Número máximo de eventos en la cola antes de descartar los más antiguos.
   * @default 200
   */
  maxQueueSize: number;

  /**
   * Endpoint HTTP para el envío de batches de auditoría.
   * @default '/api/audit/activity'
   */
  auditEndpoint: string;

  /**
   * Endpoint para navigator.sendBeacon (usado en beforeunload).
   * @default '/api/audit/beacon'
   */
  beaconEndpoint: string;

  /**
   * Clave de localStorage para persistir la cola de eventos pendientes.
   * @default '_bav_queue'
   */
  storageKey: string;

  /**
   * Si es true, envía un "pulso" de actividad cada `pulsIntervalMs` mientras
   * el usuario está activo, útil para medir tiempo activo en el backend.
   * @default true
   */
  enableActivityPulse: boolean;

  /**
   * Intervalo en ms del pulso de actividad.
   * @default 60_000 (1 minuto)
   */
  pulseIntervalMs: number;
}

export const DEFAULT_BROWSER_ACTIVITY_CONFIG: BrowserActivityConfig = {
  idleTimeoutMs: 30_000,
  batchIntervalMs: 10_000,
  maxQueueSize: 200,
  auditEndpoint: '/api/audit/activity',
  beaconEndpoint: '/api/audit/beacon',
  storageKey: '_bav_queue',
  enableActivityPulse: true,
  pulseIntervalMs: 60_000,
};

export const BROWSER_ACTIVITY_CONFIG =
  new InjectionToken<BrowserActivityConfig>('BROWSER_ACTIVITY_CONFIG', {
    providedIn: 'root',
    factory: () => DEFAULT_BROWSER_ACTIVITY_CONFIG,
  });
