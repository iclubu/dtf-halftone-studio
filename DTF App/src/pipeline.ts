// GPU pipeline, rendered in separate passes at the working (print) size:
//   1. INK     source -> ink alpha (levels, knockout, source alpha, halftone)
//   2. CLEANUP ink alpha -> open then close with a round kernel (specks, pinholes)
//   3. CHOKE   cleaned alpha -> eroded copy, used only for the white underbase
//   4. FINAL   composite / separation / underbase view -> canvas
// Blending is off everywhere: every pass writes final values (straight alpha).

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const LEVELS_GLSL = `
uniform float uLevelsBlack;
uniform float uLevelsWhite;
uniform float uLevelsMid;
uniform float uLevelsOutBlack;
uniform float uLevelsOutWhite;
vec3 applyLevels(vec3 rgb) {
  vec3 norm = clamp((rgb - uLevelsBlack) / max(uLevelsWhite - uLevelsBlack, 1e-5), 0.0, 1.0);
  vec3 g = pow(norm, vec3(1.0 / uLevelsMid));
  return uLevelsOutBlack + g * (uLevelsOutWhite - uLevelsOutBlack);
}
`;

const INK_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2  uResolution;
uniform float uCellPx;
uniform float uAngleRad;
uniform int   uShape;
uniform bool  uHalftone;
uniform vec3  uShirtColor;
uniform float uKnockoutTolerance;
uniform float uEdgeSoftness;
uniform float uMicroDot;
${LEVELS_GLSL}
out vec4 outColor;
const float PI = 3.14159265358979;

vec2 rotate(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c*p.x - s*p.y, s*p.x + c*p.y);
}
float spot_round(vec2 p)   { return 0.5 - 0.5 * cos(PI*p.x) * cos(PI*p.y); }
float spot_line(vec2 p)    { return 0.5 - 0.5 * cos(PI*p.x); }
float spot_ellipse(vec2 p) { return 0.5 - 0.5 * cos(PI*p.x) * cos(PI*p.y / 1.5); }
float spot_diamond(vec2 p) { return clamp(abs(p.x) + abs(p.y), 0.0, 1.0); }
float spot_square(vec2 p)  { return max(abs(p.x), abs(p.y)); }
float spotThreshold(vec2 f) {
  if      (uShape == 0) return spot_round(f);
  else if (uShape == 1) return spot_ellipse(f);
  else if (uShape == 2) return spot_diamond(f);
  else if (uShape == 3) return spot_square(f);
  else                  return spot_line(f);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = vec2(fc.x / uResolution.x, 1.0 - fc.y / uResolution.y);
  vec4 src = texture(uSrc, uv);
  vec3 lev = applyLevels(src.rgb);

  // Knockout by distance from the shirt color, then respect the source's own
  // transparency so removed backgrounds stay removed.
  float tol = uKnockoutTolerance / 120.0;
  float ink = clamp(distance(lev, uShirtColor) / max(tol, 0.01), 0.0, 1.0) * src.a;

  float microThreshold = uMicroDot / 10.0 * 0.2;
  if (ink < microThreshold) ink = 0.0;

  float thr = 0.5; // halftone off: plain threshold
  if (uHalftone) {
    vec2 q = rotate(fc, uAngleRad) / uCellPx;
    thr = spotThreshold(fract(q) * 2.0 - 1.0);
  }

  float soft = uEdgeSoftness / 60.0;
  float a = soft > 0.0 ? smoothstep(thr - soft, thr + soft, ink) : step(thr, ink);
  outColor = vec4(a, 0.0, 0.0, 1.0);
}
`;

// Round-kernel erosion (min) or dilation (max). Outside the image counts as empty.
const MORPH_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uIn;
uniform int  uRadius;
uniform bool uDilate;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uIn, 0);
  float r2 = (float(uRadius) + 0.5) * (float(uRadius) + 0.5);
  float m = uDilate ? 0.0 : 1.0;
  for (int dy = -uRadius; dy <= uRadius; dy++) {
    for (int dx = -uRadius; dx <= uRadius; dx++) {
      if (float(dx*dx + dy*dy) > r2) continue;
      ivec2 q = p + ivec2(dx, dy);
      bool inside = q.x >= 0 && q.y >= 0 && q.x < size.x && q.y < size.y;
      float v = inside ? texelFetch(uIn, q, 0).r : 0.0;
      m = uDilate ? max(m, v) : min(m, v);
    }
  }
  outColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

const FINAL_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uInk;
uniform sampler2D uWhite;
uniform vec2  uResolution;
uniform int   uViewMode;
uniform vec3  uShirtColor;
${LEVELS_GLSL}
out vec4 outColor;
void main() {
  vec2 fc = gl_FragCoord.xy;
  ivec2 p = ivec2(fc);
  vec2 uv = vec2(fc.x / uResolution.x, 1.0 - fc.y / uResolution.y);
  vec3 lev = applyLevels(texture(uSrc, uv).rgb);
  float a = texelFetch(uInk, p, 0).r;
  if (uViewMode == 2) {
    outColor = vec4(1.0, 1.0, 1.0, texelFetch(uWhite, p, 0).r); // underbase
  } else if (uViewMode == 1) {
    outColor = vec4(lev, a);                                    // separation (export)
  } else {
    outColor = vec4(mix(uShirtColor, lev, a), 1.0);             // preview on the shirt
  }
}
`;

export const MAX_MORPH_RADIUS = 16;

export interface PipelineParams {
  shape: number;
  cellPx: number;
  angleRad: number;
  halftone: boolean;
  shirtColor: [number, number, number];
  knockoutTolerance: number;
  edgeSoftness: number;
  microDot: number;
  cleanupRadius: number; // px at the working size; 0 = off
  chokeRadius: number;   // px at the working size; applied to the underbase only
  viewMode: number;      // 0 composite, 1 separation, 2 underbase
  levelsBlack: number;
  levelsWhite: number;
  levelsMid: number;
  levelsOutBlack: number;
  levelsOutWhite: number;
}

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; }
type Uniforms = Record<string, WebGLUniformLocation | null>;

export class Pipeline {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private inkProg: WebGLProgram;
  private morphProg: WebGLProgram;
  private finalProg: WebGLProgram;
  private u: { ink: Uniforms; morph: Uniforms; final: Uniforms };
  private src: WebGLTexture | null = null;
  private targets: Target[] = []; // 0 = ink, 1 = scratch, 2 = underbase
  private w = 0;
  private h = 0;
  readonly maxSize: number;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, dims[0], dims[1]);

    this.inkProg = this.link(INK_FRAG);
    this.morphProg = this.link(MORPH_FRAG);
    this.finalProg = this.link(FINAL_FRAG);
    const levels = ['uLevelsBlack', 'uLevelsWhite', 'uLevelsMid', 'uLevelsOutBlack', 'uLevelsOutWhite'];
    this.u = {
      ink: this.locate(this.inkProg, ['uSrc', 'uResolution', 'uCellPx', 'uAngleRad', 'uShape', 'uHalftone',
        'uShirtColor', 'uKnockoutTolerance', 'uEdgeSoftness', 'uMicroDot', ...levels]),
      morph: this.locate(this.morphProg, ['uIn', 'uRadius', 'uDilate']),
      final: this.locate(this.finalProg, ['uSrc', 'uInk', 'uWhite', 'uResolution', 'uViewMode', 'uShirtColor', ...levels]),
    };

    // One full-screen quad; all three programs bind aPos to location 0.
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
    gl.disable(gl.BLEND);
  }

  get width(): number { return this.w; }
  get height(): number { return this.h; }

  private link(fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(prog));
    return prog;
  }

  private compile(type: number, src: string): WebGLShader {
    const sh = this.gl.createShader(type)!;
    this.gl.shaderSource(sh, src); this.gl.compileShader(sh);
    if (!this.gl.getShaderParameter(sh, this.gl.COMPILE_STATUS)) {
      throw new Error('Compile failed: ' + this.gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  private locate(prog: WebGLProgram, names: string[]): Uniforms {
    const out: Uniforms = {};
    for (const n of names) out[n] = this.gl.getUniformLocation(prog, n);
    return out;
  }

  /** Upload the source image (straight alpha, mipmapped so downscaling stays clean). */
  setImage(img: ImageBitmap): void {
    const gl = this.gl;
    let upload: TexImageSource = img;
    if (Math.max(img.width, img.height) > this.maxSize) {
      const s = this.maxSize / Math.max(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(img.width * s)); c.height = Math.max(1, Math.floor(img.height * s));
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      upload = c;
    }
    if (this.src) gl.deleteTexture(this.src);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upload);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.src = tex;
  }

  /** Set the working (= export) size in pixels and (re)allocate the pass targets. */
  setOutputSize(w: number, h: number): void {
    w = Math.max(1, Math.min(this.maxSize, Math.round(w)));
    h = Math.max(1, Math.min(this.maxSize, Math.round(h)));
    if (w === this.w && h === this.h && this.targets.length) return;
    const gl = this.gl;
    for (const t of this.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    this.targets = [];
    for (let i = 0; i < 3; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete');
      this.targets.push({ tex, fbo });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.width = w; canvas.height = h;
    this.w = w; this.h = h;
  }

  private setLevels(u: Uniforms, p: PipelineParams): void {
    const gl = this.gl;
    gl.uniform1f(u.uLevelsBlack, p.levelsBlack);
    gl.uniform1f(u.uLevelsWhite, p.levelsWhite);
    gl.uniform1f(u.uLevelsMid, p.levelsMid);
    gl.uniform1f(u.uLevelsOutBlack, p.levelsOutBlack);
    gl.uniform1f(u.uLevelsOutWhite, p.levelsOutWhite);
  }

  private bindTex(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  private morph(from: number, to: number, radius: number, dilate: boolean): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[to].fbo);
    gl.useProgram(this.morphProg);
    this.bindTex(0, this.targets[from].tex);
    gl.uniform1i(this.u.morph.uIn, 0);
    gl.uniform1i(this.u.morph.uRadius, Math.min(MAX_MORPH_RADIUS, Math.max(0, Math.round(radius))));
    gl.uniform1i(this.u.morph.uDilate, dilate ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  render(p: PipelineParams): void {
    if (!this.src || !this.targets.length) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.w, this.h);
    gl.bindVertexArray(this.vao);

    // 1. ink alpha -> target 0
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].fbo);
    gl.useProgram(this.inkProg);
    const ui = this.u.ink;
    this.bindTex(0, this.src);
    gl.uniform1i(ui.uSrc, 0);
    gl.uniform2f(ui.uResolution, this.w, this.h);
    gl.uniform1f(ui.uCellPx, Math.max(1, p.cellPx));
    gl.uniform1f(ui.uAngleRad, p.angleRad);
    gl.uniform1i(ui.uShape, p.shape);
    gl.uniform1i(ui.uHalftone, p.halftone ? 1 : 0);
    gl.uniform3f(ui.uShirtColor, p.shirtColor[0], p.shirtColor[1], p.shirtColor[2]);
    gl.uniform1f(ui.uKnockoutTolerance, p.knockoutTolerance);
    gl.uniform1f(ui.uEdgeSoftness, p.edgeSoftness);
    gl.uniform1f(ui.uMicroDot, p.microDot);
    this.setLevels(ui, p);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. cleanup: open (remove specks) then close (fill pinholes); result stays in target 0
    if (p.cleanupRadius > 0) {
      this.morph(0, 1, p.cleanupRadius, false);
      this.morph(1, 0, p.cleanupRadius, true);
      this.morph(0, 1, p.cleanupRadius, true);
      this.morph(1, 0, p.cleanupRadius, false);
    }

    // 3. underbase = cleaned ink eroded by the choke (radius 0 = copy) -> target 2
    this.morph(0, 2, p.chokeRadius, false);

    // 4. final view -> canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.finalProg);
    const uf = this.u.final;
    this.bindTex(0, this.src);
    this.bindTex(1, this.targets[0].tex);
    this.bindTex(2, this.targets[2].tex);
    gl.uniform1i(uf.uSrc, 0);
    gl.uniform1i(uf.uInk, 1);
    gl.uniform1i(uf.uWhite, 2);
    gl.uniform2f(uf.uResolution, this.w, this.h);
    gl.uniform1i(uf.uViewMode, p.viewMode);
    gl.uniform3f(uf.uShirtColor, p.shirtColor[0], p.shirtColor[1], p.shirtColor[2]);
    this.setLevels(uf, p);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Ink alpha of the last render, one byte per pixel (0..255). */
  readInkAlpha(): Uint8Array {
    const gl = this.gl;
    const rgba = new Uint8Array(this.w * this.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].fbo);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const a = new Uint8Array(this.w * this.h);
    for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4];
    return a;
  }

  toBlob(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      (this.gl.canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('The browser could not encode an image this large'))),
        'image/png',
      );
    });
  }
}
