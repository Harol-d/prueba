/**
 * @file browser-visibility.model.ts
 * @description Tipos y modelos del dominio para el servicio de visibilidad del navegador.
 */

/** Tipos de eventos que puede emitir el servicio de visibilidad. */
export type VisibilityEventType =
  | 'visibilitychange'
  | 'blur'
  | 'focus'
  | 'beforeunload';

/** Estado de visibilidad del documento (alineado con la Page Visibility API). */
export type VisibilityState = 'visible' | 'hidden';

/**
 * Snapshot completo del estado de visibilidad en un momento dado.
 * Este objeto es inmutable una vez emitido por el servicio.
 */
export interface VisibilitySnapshot {
  /** Estado actual de visibilidad según la Page Visibility API. */
  readonly visibilityState: VisibilityState;
  /** `true` cuando la pestaña/ventana tiene foco activo. */
  readonly isTabActive: boolean;
  /** Fecha y hora exacta en que ocurrió el evento. */
  readonly timestamp: Date;
  /** Tipo de evento DOM que originó este snapshot. */
  readonly eventType: VisibilityEventType;
}

/**
 * Payload que se enviaría al backend de auditoría.
 * Serializable a JSON para transporte HTTP.
 */
export interface AuditPayload {
  readonly sessionId: string;
  readonly visibilityState: VisibilityState;
  readonly isTabActive: boolean;
  readonly timestamp: string; // ISO 8601
  readonly eventType: VisibilityEventType;
  readonly userAgent: string;
  readonly url: string;
}
