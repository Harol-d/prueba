/**
 * @file webgl-canvas.component.ts
 * @description Componente de renderizado 3D en tiempo real con WebGL nativo y GLSL Shaders.
 *
 * Características:
 *  - Pipeline WebGL con Vertex Shader y Fragment Shader compilados en GPU.
 *  - Malla 3D procedural (Esfera geodésica / radar de seguridad) con animación continua.
 *  - Modo Alerta reactivo: Cambia la paleta de colores y la distorsión del shader a rojo carmesí
 *    cuando se detecta pérdida de foco, máquina virtual o salida de pantalla completa.
 *  - Interactivo: responde a la rotación del ratón sobre el canvas.
 *  - Telemetría de hardware GPU en tiempo real (FPS, GPU Vendor, Renderer, Extensiones, Contexto).
 *  - Soporte para eventos de pérdida y restauración de contexto WebGL (WEBGL_lose_context).
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  signal,
} from '@angular/core';
import { isPlatformBrowser, NgClass } from '@angular/common';
import { SecurityTelemetryService } from '../../../../core/services/security-telemetry.service';

@Component({
  selector: 'app-webgl-canvas',
  standalone: true,
  imports: [NgClass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="webgl-container" [ngClass]="{ 'webgl--alert': isAlert() }">
      <!-- Encabezado con estado del hardware -->
      <div class="webgl-header">
        <div class="webgl-title">
          <span class="webgl-badge">WebGL 2.0 / GLSL</span>
          <span class="webgl-status-pill" [ngClass]="isAlert() ? 'pill--danger' : 'pill--ok'">
            {{ isAlert() ? '⚠️ ESTADO: ALERTA CRÍTICA' : '🛡️ ESTADO: SEGURO' }}
          </span>
        </div>
        <div class="webgl-fps">
          <span class="fps-val">{{ fps() }}</span>
          <span class="fps-lbl">FPS GPU</span>
        </div>
      </div>

      <!-- Canvas 3D de WebGL -->
      <div class="canvas-wrapper">
        <canvas #glCanvas class="gl-canvas"></canvas>

        <!-- Overlay de información de telemetría de hardware GPU -->
        <div class="gpu-overlay">
          <div class="overlay-row">
            <span class="overlay-key">GPU RENDERER:</span>
            <span class="overlay-val highlight">{{ gpuRenderer() }}</span>
          </div>
          <div class="overlay-row">
            <span class="overlay-key">GPU VENDOR:</span>
            <span class="overlay-val">{{ gpuVendor() }}</span>
          </div>
          <div class="overlay-row">
            <span class="overlay-key">MAX TEXTURE:</span>
            <span class="overlay-val">{{ maxTextureSize() }}px</span>
          </div>
          <div class="overlay-row">
            <span class="overlay-key">EXTENSIÓN LOSS:</span>
            <span class="overlay-val" [ngClass]="contextLost() ? 'val--danger' : 'val--ok'">
              {{ contextLost() ? 'CONTEXTO PERDIDO' : 'ACTIVO' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Barra inferior con controles de prueba de WebGL -->
      <div class="webgl-toolbar">
        <span class="webgl-hint">
          💡 Interacción: Mueve el cursor sobre la esfera 3D para rotarla con la GPU.
        </span>
        <div class="webgl-actions">
          <button
            type="button"
            class="btn-webgl btn--warning"
            (click)="simulateContextLoss()"
            [disabled]="contextLost()"
          >
            ⚡ Forzar Pérdida Contexto
          </button>
          <button
            type="button"
            class="btn-webgl btn--restore"
            (click)="restoreContext()"
            [disabled]="!contextLost()"
          >
            🔄 Restaurar Contexto
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }

    .webgl-container {
      background: #090e17;
      border: 1px solid #1e293b;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 1.5rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      transition: border-color .3s, box-shadow .3s;
    }

    .webgl-container.webgl--alert {
      border-color: #ef4444;
      box-shadow: 0 0 25px rgba(239, 68, 68, 0.25);
    }

    .webgl-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.25rem;
      background: #0f172a;
      border-bottom: 1px solid #1e293b;
    }

    .webgl-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .webgl-badge {
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      border: 1px solid rgba(56, 189, 248, 0.3);
      font-family: monospace;
    }

    .webgl-status-pill {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      letter-spacing: 0.05em;
    }

    .pill--ok {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }

    .pill--danger {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
      animation: pulseAlert 1s infinite alternate;
    }

    .webgl-fps {
      display: flex;
      align-items: baseline;
      gap: 0.35rem;
      font-family: monospace;
    }

    .fps-val {
      font-size: 1.1rem;
      font-weight: 700;
      color: #38bdf8;
    }

    .fps-lbl {
      font-size: 0.65rem;
      color: #64748b;
    }

    .canvas-wrapper {
      position: relative;
      width: 100%;
      height: 240px;
      background: radial-gradient(circle at center, #0f1d33 0%, #060911 100%);
      overflow: hidden;
    }

    .gl-canvas {
      width: 100%;
      height: 100%;
      display: block;
      cursor: crosshair;
    }

    .gpu-overlay {
      position: absolute;
      bottom: 0.75rem;
      left: 0.75rem;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(51, 65, 85, 0.6);
      border-radius: 6px;
      padding: 0.5rem 0.75rem;
      font-family: monospace;
      font-size: 0.65rem;
      color: #94a3b8;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      pointer-events: none;
      max-width: 85%;
    }

    .overlay-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .overlay-key {
      color: #64748b;
      font-weight: 600;
    }

    .overlay-val {
      color: #cbd5e1;
      text-overflow: ellipsis;
      overflow: hidden;
    }

    .overlay-val.highlight {
      color: #38bdf8;
      font-weight: 700;
    }

    .val--ok { color: #4ade80; }
    .val--danger { color: #f87171; font-weight: 700; }

    .webgl-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.6rem 1rem;
      background: #0f172a;
      border-top: 1px solid #1e293b;
      font-size: 0.7rem;
    }

    .webgl-hint {
      color: #64748b;
    }

    .webgl-actions {
      display: flex;
      gap: 0.5rem;
    }

    .btn-webgl {
      border: none;
      border-radius: 6px;
      padding: 0.3rem 0.6rem;
      font-size: 0.68rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .btn-webgl:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .btn--warning {
      background: #78350f;
      color: #fde68a;
    }
    .btn--warning:hover:not(:disabled) {
      background: #92400e;
    }

    .btn--restore {
      background: #065f46;
      color: #a7f3d0;
    }
    .btn--restore:hover:not(:disabled) {
      background: #047857;
    }

    @keyframes pulseAlert {
      from { opacity: 0.7; }
      to { opacity: 1; transform: scale(1.02); }
    }
  `],
})
export class WebglCanvasComponent implements OnInit, OnDestroy {
  @ViewChild('glCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  @Input() set alertMode(value: boolean) {
    this.isAlert.set(value);
  }

  readonly isAlert = signal<boolean>(false);
  readonly fps = signal<number>(60);
  readonly gpuRenderer = signal<string>('Detectando...');
  readonly gpuVendor = signal<string>('Detectando...');
  readonly maxTextureSize = signal<number>(0);
  readonly contextLost = signal<boolean>(false);

  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private animFrameId: number | null = null;
  private loseContextExt: { loseContext: () => void; restoreContext: () => void } | null = null;

  private rotX = 0;
  private rotY = 0;
  private targetRotX = 0;
  private targetRotY = 0;
  private lastTime = 0;
  private frameCount = 0;
  private lastFpsTime = 0;

  private vertexBuffer: WebGLBuffer | null = null;
  private numVertices = 0;

  constructor(
    @Inject(PLATFORM_ID) private readonly platformId: object,
    private readonly ngZone: NgZone,
    private readonly securityTelemetry: SecurityTelemetryService,
  ) {}

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.initWebGL();
    }
  }

  ngOnDestroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
    if (this.gl && this.vertexBuffer) {
      this.gl.deleteBuffer(this.vertexBuffer);
    }
    if (this.gl && this.program) {
      this.gl.deleteProgram(this.program);
    }
  }

  // ── Inicialización de WebGL ──────────────────────────────────────────────

  private initWebGL(): void {
    const canvas = this.canvasRef.nativeElement;

    // Listeners de pérdida y restauración de contexto WebGL
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost.set(true);
      if (this.animFrameId !== null) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }
      this.securityTelemetry.emitCustomEvent({
        type: 'webgl_context_lost',
        label: 'Contexto WebGL Perdido',
        detail: 'El driver o navegador invalidó el contexto gráfico WebGL',
        icon: '💥',
        severity: 'critical',
      });
    });

    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost.set(false);
      this.initGLContext();
      this.startRenderLoop();
      this.securityTelemetry.emitCustomEvent({
        type: 'webgl_context_restored',
        label: 'Contexto WebGL Restaurado',
        detail: 'El subsistema 3D se ha reinicializado correctamente',
        icon: '🔄',
        severity: 'info',
      });
    });

    // Interacción del ratón para rotar en 3D
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      this.targetRotY = x * Math.PI * 1.5;
      this.targetRotX = y * Math.PI * 1.5;
    });

    this.initGLContext();
    this.startRenderLoop();
  }

  private initGLContext(): void {
    const canvas = this.canvasRef.nativeElement;
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

    if (!gl) {
      this.gpuRenderer.set('WebGL no soportado');
      return;
    }

    this.gl = gl;

    // Extraer extensión de pérdida de contexto
    this.loseContextExt = gl.getExtension('WEBGL_lose_context') as unknown as {
      loseContext: () => void;
      restoreContext: () => void;
    };

    // Extraer propiedades GPU
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const unmaskedRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      const unmaskedVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
      this.gpuRenderer.set(unmaskedRenderer || 'Desconocido');
      this.gpuVendor.set(unmaskedVendor || 'Desconocido');
    } else {
      this.gpuRenderer.set(gl.getParameter(gl.RENDERER) || 'Estándar');
      this.gpuVendor.set(gl.getParameter(gl.VENDOR) || 'Estándar');
    }

    this.maxTextureSize.set(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0);

    // Compilar Shaders
    this.buildShaderProgram(gl);
    this.build3DGeometry(gl);
  }

  // ── Construcción de Shaders GLSL ─────────────────────────────────────────

  private buildShaderProgram(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const vsSource = `
      attribute vec3 aPosition;
      attribute vec3 aColor;

      uniform mat4 uMatrix;
      uniform float uTime;
      uniform float uAlert;

      varying vec3 vColor;
      varying float vDist;

      void main() {
        vec3 pos = aPosition;
        // Distorsión del shader cuando está en modo alerta
        if (uAlert > 0.5) {
          pos.x += sin(pos.y * 10.0 + uTime * 6.0) * 0.04;
          pos.y += cos(pos.x * 10.0 + uTime * 6.0) * 0.04;
        }

        gl_Position = uMatrix * vec4(pos, 1.0);
        gl_PointSize = (uAlert > 0.5) ? 4.0 : 2.5;

        vColor = (uAlert > 0.5) ? vec3(1.0, 0.15, 0.2) : aColor;
        vDist = length(pos);
      }
    `;

    const fsSource = `
      precision mediump float;
      varying vec3 vColor;
      varying float vDist;
      uniform float uAlert;
      uniform float uTime;

      void main() {
        vec3 col = vColor;
        if (uAlert > 0.5) {
          // Pulso carmesí intermitente
          float pulse = 0.7 + 0.3 * sin(uTime * 8.0);
          col *= pulse;
        }
        gl_FragColor = vec4(col, 0.85);
      }
    `;

    const vs = this.compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSource);

    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Error al vincular programa WebGL:', gl.getProgramInfoLog(prog));
      return;
    }

    this.program = prog;
  }

  private compileShader(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    type: number,
    source: string,
  ): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Error al compilar shader:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  // ── Generación de Geometría 3D Procedural (Esfera / Radar de Malla) ──────

  private build3DGeometry(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const vertices: number[] = [];
    const rings = 16;
    const segments = 24;
    const radius = 0.75;

    for (let r = 0; r <= rings; r++) {
      const theta = (r * Math.PI) / rings;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      for (let s = 0; s <= segments; s++) {
        const phi = (s * 2 * Math.PI) / segments;
        const x = radius * sinTheta * Math.cos(phi);
        const y = radius * cosTheta;
        const z = radius * sinTheta * Math.sin(phi);

        // Color cian/verde cibernético
        const cr = 0.1 + 0.2 * (x / radius);
        const cg = 0.7 + 0.3 * (y / radius);
        const cb = 0.9;

        vertices.push(x, y, z, cr, cg, cb);

        // Conectar anillos
        if (s > 0) {
          const prevPhi = ((s - 1) * 2 * Math.PI) / segments;
          const px = radius * sinTheta * Math.cos(prevPhi);
          const py = radius * cosTheta;
          const pz = radius * sinTheta * Math.sin(prevPhi);
          vertices.push(px, py, pz, cr, cg, cb);
        }
      }
    }

    this.numVertices = vertices.length / 6;

    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  }

  // ── Bucle de Renderizado ─────────────────────────────────────────────────

  private startRenderLoop(): void {
    this.ngZone.runOutsideAngular(() => {
      const render = (time: number) => {
        this.renderFrame(time);
        this.animFrameId = requestAnimationFrame(render);
      };
      this.animFrameId = requestAnimationFrame(render);
    });
  }

  private renderFrame(timeMs: number): void {
    const gl = this.gl;
    const prog = this.program;
    if (!gl || !prog || this.contextLost()) return;

    const canvas = this.canvasRef.nativeElement;

    // Ajustar dimensiones internas del canvas
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = Math.floor(canvas.clientWidth * dpr);
    const displayHeight = Math.floor(canvas.clientHeight * dpr);

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    // Calcular FPS
    this.frameCount++;
    if (timeMs - this.lastFpsTime >= 1000) {
      const currentFps = Math.round((this.frameCount * 1000) / (timeMs - this.lastFpsTime));
      this.ngZone.run(() => this.fps.set(currentFps));
      this.frameCount = 0;
      this.lastFpsTime = timeMs;
    }

    const t = timeMs * 0.001;

    // Suavizado de rotación
    this.rotX += (this.targetRotX - this.rotX) * 0.05;
    this.rotY += (this.targetRotY - this.rotY) * 0.05;

    // Rotación automática continua
    const speed = this.isAlert() ? 1.8 : 0.6;
    const currentRotY = this.rotY + t * speed;
    const currentRotX = this.rotX + Math.sin(t * 0.8) * 0.2;

    // Limpiar canvas
    gl.clearColor(0.03, 0.05, 0.09, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    gl.useProgram(prog);

    // Enviar Uniforms
    const uMatrixLoc = gl.getUniformLocation(prog, 'uMatrix');
    const uTimeLoc = gl.getUniformLocation(prog, 'uTime');
    const uAlertLoc = gl.getUniformLocation(prog, 'uAlert');

    gl.uniform1f(uTimeLoc, t);
    gl.uniform1f(uAlertLoc, this.isAlert() ? 1.0 : 0.0);

    // Calcular matriz de Proyección * Vista * Modelo (Ortográfica simple con rotación)
    const aspect = canvas.width / (canvas.height || 1);
    const matrix = this.createTransformMatrix(aspect, currentRotX, currentRotY);
    gl.uniformMatrix4fv(uMatrixLoc, false, matrix);

    // Vincular Buffer de Atributos
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    const aPosLoc = gl.getAttribLocation(prog, 'aPosition');
    const aColLoc = gl.getAttribLocation(prog, 'aColor');

    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, 24, 0);

    gl.enableVertexAttribArray(aColLoc);
    gl.vertexAttribPointer(aColLoc, 3, gl.FLOAT, false, 24, 12);

    // Dibujar líneas y puntos
    gl.drawArrays(gl.LINES, 0, this.numVertices);
    gl.drawArrays(gl.POINTS, 0, this.numVertices);
  }

  private createTransformMatrix(aspect: number, rx: number, ry: number): Float32Array {
    const cx = Math.cos(rx);
    const sx = Math.sin(rx);
    const cy = Math.cos(ry);
    const sy = Math.sin(ry);

    // Matriz de rotación 3D combinada
    const scale = 0.9;
    const m00 = cy * scale / (aspect > 1 ? aspect : 1);
    const m01 = 0;
    const m02 = -sy * scale;
    const m10 = (sx * sy) * scale;
    const m11 = (cx) * scale * (aspect <= 1 ? aspect : 1);
    const m12 = (sx * cy) * scale;
    const m20 = (cx * sy);
    const m21 = -sx;
    const m22 = (cx * cy);

    return new Float32Array([
      m00, m10, m20, 0,
      m01, m11, m21, 0,
      m02, m12, m22, 0,
      0, 0, 0, 1,
    ]);
  }

  // ── Acciones de Prueba de WebGL ──────────────────────────────────────────

  simulateContextLoss(): void {
    if (this.loseContextExt) {
      this.loseContextExt.loseContext();
    }
  }

  restoreContext(): void {
    if (this.loseContextExt) {
      this.loseContextExt.restoreContext();
    }
  }
}
