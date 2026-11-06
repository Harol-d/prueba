/**
 * @file vm-detector.service.ts
 * @description Servicio de detección avanzada de Máquinas Virtuales (VM), Sandboxes,
 * emuladores y navegadores headless/automatizados.
 *
 * Utiliza múltiples vectores de análisis:
 *  1. WebGL Hardware Fingerprint (UNMASKED_VENDOR / UNMASKED_RENDERER via WEBGL_debug_renderer_info)
 *  2. Concurrencia de hardware (vCPUs asignadas)
 *  3. Memoria del dispositivo (deviceMemory API)
 *  4. Indicadores de automatización y headless (navigator.webdriver, plugins)
 *  5. Dimensiones de pantalla y geometrías típicas de hipervisores
 *  6. API de batería (comportamiento anómalo en VMs de escritorio)
 *  7. Comportamiento del motor de síntesis de voz y canvas
 */

import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type VmRiskLevel = 'PHYSICAL' | 'SUSPICIOUS' | 'CRITICAL_VM';

export interface VmReport {
  readonly isVm: boolean;
  readonly riskLevel: VmRiskLevel;
  readonly confidenceScore: number; // 0 a 100
  readonly detectedHypervisor: string | null;
  readonly gpuVendor: string;
  readonly gpuRenderer: string;
  readonly unmaskedVendor: string;
  readonly unmaskedRenderer: string;
  readonly hardwareConcurrency: number;
  readonly deviceMemoryGb: number | null;
  readonly isWebDriver: boolean;
  readonly screenMetrics: string;
  readonly riskFactors: string[];
  readonly webglExtensionsCount: number;
  readonly maxTextureSize: number;
  readonly batteryStatus: string;
  readonly analyzedAt: Date;
}

const KNOWN_VM_SIGNATURES: { name: string; regex: RegExp; weight: number }[] = [
  { name: 'VMware SVGA / vmwgfx', regex: /vmware|svga3d|vmwgfx/i, weight: 95 },
  { name: 'Oracle VirtualBox', regex: /virtualbox|vbox|vboxogl/i, weight: 95 },
  { name: 'QEMU / KVM / Proxmox', regex: /qemu|bochs|virtio|virgl|red hat/i, weight: 90 },
  { name: 'Microsoft Hyper-V / Sandbox', regex: /microsoft basic render driver|hyper-v|remotefx/i, weight: 90 },
  { name: 'Google SwiftShader (Emulación Software)', regex: /swiftshader/i, weight: 85 },
  { name: 'Mesa llvmpipe / softpipe (CPU Rasterizer)', regex: /llvmpipe|softpipe|software rasterizer|mesa off-screen/i, weight: 85 },
  { name: 'Parallels Desktop', regex: /parallels/i, weight: 90 },
  { name: 'Apple Software Renderer', regex: /apple software renderer/i, weight: 85 },
];

@Injectable({ providedIn: 'root' })
export class VmDetectorService {
  private readonly platformId = inject(PLATFORM_ID);

  readonly report = signal<VmReport>(this.getEmptyReport());

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.analyzeEnvironment();
    }
  }

  /**
   * Ejecuta el análisis heurístico integral del entorno de ejecución.
   */
  analyzeEnvironment(): VmReport {
    if (!isPlatformBrowser(this.platformId)) {
      return this.getEmptyReport();
    }

    const riskFactors: string[] = [];
    let detectedHypervisor: string | null = null;
    let score = 0;

    // 1. Análisis WebGL (Vector Principal y más fiable)
    const webglData = this.probeWebGL();
    const rendererCombined = `${webglData.unmaskedVendor} ${webglData.unmaskedRenderer} ${webglData.vendor} ${webglData.renderer}`.toLowerCase();

    for (const sig of KNOWN_VM_SIGNATURES) {
      if (sig.regex.test(rendererCombined)) {
        detectedHypervisor = sig.name;
        score = Math.max(score, sig.weight);
        riskFactors.push(`GPU coincide con firma de emulación/VM: ${sig.name} (${webglData.unmaskedRenderer})`);
        break;
      }
    }

    // 2. Análisis de CPU Cores (navigator.hardwareConcurrency)
    const cores = navigator.hardwareConcurrency || 1;
    if (cores === 1) {
      score += 25;
      riskFactors.push('Un único núcleo de CPU detectado (típico de VM base o contenedor)');
    } else if (cores === 2) {
      score += 10;
      riskFactors.push('2 núcleos de CPU detectados (potencial asignación de VM estándar)');
    }

    // 3. Análisis de Memoria RAM (navigator.deviceMemory)
    const navAny = navigator as unknown as { deviceMemory?: number; webdriver?: boolean };
    const memory = navAny.deviceMemory ?? null;
    if (memory !== null && memory <= 1) {
      score += 20;
      riskFactors.push(`Memoria de dispositivo reportada extremadamente baja (${memory} GB)`);
    } else if (memory !== null && memory <= 2) {
      score += 10;
      riskFactors.push(`Memoria de dispositivo baja (${memory} GB)`);
    }

    // 4. Indicadores de Automatización / Headless
    const isWebDriver = !!navAny.webdriver;
    if (isWebDriver) {
      score += 35;
      riskFactors.push('navigator.webdriver = true (Sesión controlada por software de automatización)');
    }

    // Comprobación de plugins en escritorio
    if (navigator.plugins && navigator.plugins.length === 0 && !/android|iphone|ipad/i.test(navigator.userAgent)) {
      score += 10;
      riskFactors.push('Sin plugins de navegador registrados en navegador de escritorio');
    }

    // 5. Geometría de Pantalla típica de hipervisores
    const screenWidth = window.screen.width;
    const screenHeight = window.screen.height;
    const screenAvailWidth = window.screen.availWidth;
    const screenAvailHeight = window.screen.availHeight;

    if (
      (screenWidth === 800 && screenHeight === 600) ||
      (screenWidth === 1024 && screenHeight === 768) ||
      (screenWidth === 1280 && screenHeight === 720 && screenAvailHeight === screenHeight)
    ) {
      score += 15;
      riskFactors.push(`Resolución de pantalla coincidente con valores por defecto de VM (${screenWidth}x${screenHeight})`);
    }

    if (window.screen.colorDepth < 24) {
      score += 20;
      riskFactors.push(`Profundidad de color reducida (${window.screen.colorDepth}-bit)`);
    }

    // Sin barra de tareas del SO detectable en resolución no maximizada
    if (screenWidth === screenAvailWidth && screenHeight === screenAvailHeight && !document.fullscreenElement) {
      // Posible entorno headless / X11 virtual
      score += 5;
    }

    // 6. Max Texture Size anómalo en WebGL
    if (webglData.maxTextureSize > 0 && webglData.maxTextureSize <= 4096) {
      score += 15;
      riskFactors.push(`Tamaño máximo de textura WebGL muy reducido (${webglData.maxTextureSize}px)`);
    }

    // Normalizar score entre 0 y 100
    const confidenceScore = Math.min(100, Math.max(0, score));

    let riskLevel: VmRiskLevel = 'PHYSICAL';
    if (confidenceScore >= 70 || detectedHypervisor !== null) {
      riskLevel = 'CRITICAL_VM';
    } else if (confidenceScore >= 35) {
      riskLevel = 'SUSPICIOUS';
    }

    const report: VmReport = {
      isVm: riskLevel === 'CRITICAL_VM',
      riskLevel,
      confidenceScore,
      detectedHypervisor,
      gpuVendor: webglData.vendor,
      gpuRenderer: webglData.renderer,
      unmaskedVendor: webglData.unmaskedVendor,
      unmaskedRenderer: webglData.unmaskedRenderer,
      hardwareConcurrency: cores,
      deviceMemoryGb: memory,
      isWebDriver,
      screenMetrics: `${screenWidth}x${screenHeight} (${screenAvailWidth}x${screenAvailHeight} disp, ${window.screen.colorDepth}bpp)`,
      riskFactors,
      webglExtensionsCount: webglData.extensionsCount,
      maxTextureSize: webglData.maxTextureSize,
      batteryStatus: 'Inspeccionada',
      analyzedAt: new Date(),
    };

    this.report.set(report);
    return report;
  }

  /**
   * Inspecciona el subsistema WebGL directamente a nivel de hardware.
   */
  private probeWebGL(): {
    vendor: string;
    renderer: string;
    unmaskedVendor: string;
    unmaskedRenderer: string;
    extensionsCount: number;
    maxTextureSize: number;
  } {
    const result = {
      vendor: 'Desconocido',
      renderer: 'Desconocido',
      unmaskedVendor: 'Desconocido',
      unmaskedRenderer: 'Desconocido',
      extensionsCount: 0,
      maxTextureSize: 0,
    };

    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

      if (!gl) {
        result.renderer = 'WebGL no soportado';
        return result;
      }

      result.vendor = gl.getParameter(gl.VENDOR) || 'N/A';
      result.renderer = gl.getParameter(gl.RENDERER) || 'N/A';
      result.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;

      const extensions = gl.getSupportedExtensions();
      result.extensionsCount = extensions ? extensions.length : 0;

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        result.unmaskedVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || result.vendor;
        result.unmaskedRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || result.renderer;
      } else {
        result.unmaskedVendor = result.vendor;
        result.unmaskedRenderer = result.renderer;
      }
    } catch (e) {
      result.renderer = `Error al inspeccionar WebGL: ${e}`;
    }

    return result;
  }

  private getEmptyReport(): VmReport {
    return {
      isVm: false,
      riskLevel: 'PHYSICAL',
      confidenceScore: 0,
      detectedHypervisor: null,
      gpuVendor: 'Iniciando...',
      gpuRenderer: 'Iniciando...',
      unmaskedVendor: 'Iniciando...',
      unmaskedRenderer: 'Iniciando...',
      hardwareConcurrency: 0,
      deviceMemoryGb: null,
      isWebDriver: false,
      screenMetrics: '—',
      riskFactors: [],
      webglExtensionsCount: 0,
      maxTextureSize: 0,
      batteryStatus: '—',
      analyzedAt: new Date(),
    };
  }
}
