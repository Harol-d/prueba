/**
 * @file browser-activity.model.ts
 * @description Modelos extendidos para el sistema empresarial de monitoreo de actividad.
 * Extiende los tipos base de browser-visibility.model.ts con idle, network y auditoría.
 */

import { VisibilitySnapshot, VisibilityState } from './browser-visibility.model';

// ─────────────────────────────────────────────────────────────────────────────
// Idle Detection
// ─────────────────────────────────────────────────────────────────────────────

/** Eventos DOM que se consideran "actividad" del usuario. */
export const USER_ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'keydown',
  'keyup',
  'scroll',
  'wheel',
  'touchstart',
  'touchmove',
  'touchend',
  'pointerdown',
  'pointermove',
] as const;

export type UserActivityEvent = (typeof USER_ACTIVITY_EVENTS)[number];

/** Estado de inactividad del usuario. */
export type IdleStatus = 'active' | 'idle';

export interface IdleState {
  /** Estado actual: activo o inactivo. */
  readonly status: IdleStatus;
  /** Fecha en que el usuario entró en idle (null si está activo). */
  readonly idleSince: Date | null;
  /** Último evento de actividad registrado. */
  readonly lastActivityEvent: UserActivityEvent | null;
  /** Timestamp del snapshot. */
  readonly timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Network Status
// ─────────────────────────────────────────────────────────────────────────────

export interface NetworkState {
  readonly isOnline: boolean;
  /** Latencia estimada en ms (via navigator.connection si disponible). */
  readonly effectiveType: string | null;
  readonly timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Activity State (Facade)
// ─────────────────────────────────────────────────────────────────────────────

/** Estado unificado que combina visibilidad + idle + red. */
export interface ActivityState {
  readonly visibility: VisibilitySnapshot;
  readonly idle: IdleState;
  readonly network: NetworkState;
  /** Resumen del nivel de atención del usuario (calculado). */
  readonly attentionLevel: 'full' | 'partial' | 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit Queue & Batch
// ─────────────────────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'visibility_change'
  | 'idle_change'
  | 'network_change'
  | 'activity_pulse'
  | 'session_start'
  | 'session_end';

/** Evento individual encolado para auditoría. */
export interface AuditEvent {
  readonly id: string;                 // UUID v4 simplificado
  readonly sessionId: string;
  readonly sessionStart: string;       // ISO 8601
  readonly type: AuditEventType;
  readonly timestamp: string;          // ISO 8601
  readonly visibilityState: VisibilityState;
  readonly isTabActive: boolean;
  readonly idleStatus: IdleStatus;
  readonly isOnline: boolean;
  readonly attentionLevel: 'full' | 'partial' | 'none';
  readonly url: string;
  readonly userAgent: string;
  readonly metadata?: Record<string, unknown>;
}

/** Payload de un batch enviado al backend. */
export interface AuditBatch {
  readonly batchId: string;
  readonly sessionId: string;
  readonly events: AuditEvent[];
  readonly count: number;
  readonly flushedAt: string;          // ISO 8601
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Stats
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionStats {
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly totalEvents: number;
  readonly queuedEvents: number;
  readonly sentBatches: number;
  readonly idleCount: number;
  readonly visibilityHiddenCount: number;
  readonly networkDropCount: number;
}
