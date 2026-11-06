import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { routes } from './app.routes';
import { provideClientHydration } from '@angular/platform-browser';
import { BROWSER_ACTIVITY_CONFIG } from './core/services/browser-activity.config';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideClientHydration(),

    // HttpClient con Fetch API (compatible con SSR en Angular 22)
    provideHttpClient(withFetch()),

    // Configuración personalizada del sistema de monitoreo (opcional: sobrescribe defaults)
    {
      provide: BROWSER_ACTIVITY_CONFIG,
      useValue: {
        idleTimeoutMs: 30_000,       // 30s sin actividad → idle
        batchIntervalMs: 10_000,     // flush al backend cada 10s
        maxQueueSize: 200,
        auditEndpoint: '/api/audit/activity',
        beaconEndpoint: '/api/audit/beacon',
        storageKey: '_bav_queue',
        enableActivityPulse: true,
        pulseIntervalMs: 60_000,     // heartbeat al backend cada 1min
      },
    },
  ],
};
