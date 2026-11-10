import './style.css';
import { Pipeline, MAX_MORPH_RADIUS, type PipelineParams } from './pipeline';
import { validate, toInches, fromInches, type Unit, type Finding } from './validate';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as unknown as T;

// External background remover, opened in a popup. Swap the URL to use another service
// (e.g. https://new.express.adobe.com/tools/remove-background).
const BG_REMOVER_URL = 'https://www.remove.bg/upload';

const TARGET_DPI = 300;
const MAX_WORK_PIXELS = 40_000_000; // keeps GPU memory sane (~3 × 40 MB targets + canvas)

const canvas = $<HTMLCanvasElement>('canvas');
const emptyState = $<HTMLDivElement>('empty-state');
const fileInput = $<HTMLInputElement>('fileInput');
const btnExport = $<HTMLButtonElement>('btnExport');
const dropZone = $<HTMLDivElement>('dropZone');

const btnBgRemover = $<HTMLButtonElement>('btnBgRemover');
const btnInitialApply = $<HTMLButtonElement>('btnInitialApply');
const btnApply = $<HTMLButtonElement>('btnApply');
const advancedSettings = $<HTMLDivElement>('advancedSettings');
const preflightBox = $<HTMLDivElement>('preflightBox');

const btnAutoTone = $<HTMLButtonElement>('btnAutoTone');

const printWidthInput = $<HTMLInputElement>('printWidth');
const printHeightInput = $<HTMLInputElement>('printHeight');
const filmWidthInput = $<HTMLInputElement>('filmWidth');
const sizeFindings = $<HTMLDivElement>('sizeFindings');

const inputs = {
  shirtColor: $<HTMLInputElement>('shirtColor'),
  shirtHex: $<HTMLInputElement>('shirtHex'),
  knockoutTolerance: $<HTMLInputElement>('knockoutTolerance'),
  edgeSoftness: $<HTMLInputElement>('edgeSoftness'),
  patternScaleSelect: $<HTMLSelectElement>('patternScaleSelect'),
  patternAngleInput: $<HTMLInputElement>('patternAngleInput'),
  halftoneShape: $<HTMLSelectElement>('halftoneShape'),
  enableHalftone: $<HTMLInputElement>('enableHalftone'),
  cleanupIntensity: $<HTMLInputElement>('cleanupIntensity'),
  microDot: $<HTMLInputElement>('microDot'),
  enableUnderbase: $<HTMLInputElement>('enableUnderbase'),
  chokePx: $<HTMLInputElement>('chokePx'),
};

let pipeline: Pipeline;
try { pipeline = new Pipeline(canvas); } catch (err) { alert('WebGL2 not available'); throw err; }

let source: ImageBitmap | null = null;
let originalFile: File | null = null; // the loaded file (used for the export filename)
let srcWidth = 0, srcHeight = 0;
let currentViewMode = 0;
let unit: Unit = 'in';
let printWidthIn = 0;
let exportBlocked = false;

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

function hexToRgb(hex: string): [number, number, number] {
  const bigint = parseInt(hex.replace('#', ''), 16);
  return [((bigint >> 16) & 255) / 255, ((bigint >> 8) & 255) / 255, (bigint & 255) / 255];
}

/** Downscaled RGBA copy for histogram / auto-tone, so huge images don't allocate hundreds of MB. */
function sampleImage(img: ImageBitmap, maxSide = 1024): Uint8ClampedArray {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const temp = document.createElement('canvas');
  temp.width = Math.max(1, Math.round(img.width * s)); temp.height = Math.max(1, Math.round(img.height * s));
  const ctx = temp.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, temp.width, temp.height);
  return ctx.getImageData(0, 0, temp.width, temp.height).data;
}

function lumaHistogram(data: Uint8ClampedArray): { hist: number[]; total: number } {
  const hist = new Array(256).fill(0);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // ignore transparent pixels
    hist[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
    total++;
  }
  return { hist, total };
}

// ---------- print size ----------
const printHeightIn = () => (srcWidth ? (printWidthIn * srcHeight) / srcWidth : 0);

function workSize(): { w: number; h: number; dpi: number; capped: boolean } {
  let w = printWidthIn * TARGET_DPI, h = printHeightIn() * TARGET_DPI;
  const s = Math.min(1, pipeline.maxSize / Math.max(w, h), Math.sqrt(MAX_WORK_PIXELS / Math.max(1, w * h)));
  w = Math.max(1, Math.floor(w * s)); h = Math.max(1, Math.floor(h * s));
  return { w, h, dpi: w / printWidthIn, capped: s < 1 };
}

function showPrintSize(): void {
  if (document.activeElement !== printWidthInput) printWidthInput.value = fmt(fromInches(printWidthIn, unit));
  if (document.activeElement !== printHeightInput) printHeightInput.value = fmt(fromInches(printHeightIn(), unit));
}

printWidthInput.addEventListener('input', () => {
  const v = parseFloat(printWidthInput.value);
  if (v > 0) { printWidthIn = toInches(v, unit); showPrintSize(); update(); }
});
printHeightInput.addEventListener('input', () => {
  const v = parseFloat(printHeightInput.value);
  if (v > 0 && srcHeight) { printWidthIn = (toInches(v, unit) * srcWidth) / srcHeight; showPrintSize(); update(); }
});
document.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((btn) => {
  btn.addEventListener('click', () => {
    unit = btn.dataset.unit as Unit;
    document.querySelectorAll('[data-unit]').forEach((b) => b.classList.toggle('active', b === btn));
    printWidthInput.blur(); printHeightInput.blur();
    showPrintSize();
  });
});

function renderFindings(findings: Finding[]): void {
  sizeFindings.replaceChildren(...findings.map((f) => {
    const d = document.createElement('div');
    d.className = `finding ${f.level}`;
    d.textContent = f.message;
    return d;
  }));
}

// ---------- auto-tone ----------
function runAutoTone() {
  if (!source) return;
  const { hist, total } = lumaHistogram(sampleImage(source));
  if (!total) return;
  let sum = 0, lowThresh = 0, highThresh = 255;
  for (let i = 0; i < 256; i++) { sum += hist[i]; if (sum > total * 0.05) { lowThresh = i; break; } }
  sum = 0;
  for (let i = 255; i >= 0; i--) { sum += hist[i]; if (sum > total * 0.05) { highThresh = i; break; } }
  if (highThresh <= lowThresh) highThresh = Math.min(255, lowThresh + 1);

  $<HTMLInputElement>('levelsBlack').value = lowThresh.toString();
  $<HTMLInputElement>('levelsBlackSlider').value = lowThresh.toString();
  $<HTMLInputElement>('levelsWhite').value = highThresh.toString();
  $<HTMLInputElement>('levelsWhiteSlider').value = highThresh.toString();
  $<HTMLInputElement>('levelsMid').value = '1.00';
  $<HTMLInputElement>('levelsMidSlider').value = '1.00';
  update();
}

btnAutoTone?.addEventListener('click', (e) => { e.stopPropagation(); runAutoTone(); });

// ---------- external background remover (popup) ----------
btnBgRemover.addEventListener('click', () => {
  const w = Math.min(1200, screen.availWidth - 80), h = Math.min(900, screen.availHeight - 80);
  const left = Math.round((screen.availWidth - w) / 2), top = Math.round((screen.availHeight - h) / 2);
  const popup = window.open(BG_REMOVER_URL, 'bgRemover', `popup,width=${w},height=${h},left=${left},top=${top}`);
  if (popup) { popup.opener = null; popup.focus(); return; } // cut the link back to this page
  alert(`Your browser blocked the pop-up. Allow pop-ups for this page, or open ${BG_REMOVER_URL} yourself.`);
});

// ---------- progressive disclosure ----------
btnInitialApply.addEventListener('click', () => {
  btnInitialApply.style.display = 'none';
  advancedSettings.style.display = 'block';
  preflightBox.style.display = 'flex';
  btnApply.style.display = 'flex';
  update();
});

// ---------- inputs ----------
inputs.shirtColor.addEventListener('input', (e) => {
  inputs.shirtHex.value = (e.target as HTMLInputElement).value.toUpperCase();
  update();
});
inputs.shirtHex.addEventListener('input', () => {
  const m = /^#?([0-9a-f]{6})$/i.exec(inputs.shirtHex.value.trim());
  if (!m) return; // wait until the hex code is complete
  inputs.shirtColor.value = '#' + m[1].toLowerCase();
  update();
});

document.querySelectorAll('input[name="view"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    const val = (e.target as HTMLInputElement).value;
    currentViewMode = val === 'composite' ? 0 : val === 'color' ? 1 : 2;
    update();
  });
});

(window as any).setZoom = (val: number) => { canvas.style.setProperty('--zoom', (val / 100).toString()); };

function syncInputs(id: string, otherId: string) {
  const a = document.getElementById(id) as HTMLInputElement | null;
  const b = document.getElementById(otherId) as HTMLInputElement | null;
  if (!a || !b) return;
  const sync = (val: string) => { a.value = val; b.value = val; update(); };
  a.addEventListener('input', () => sync(a.value));
  b.addEventListener('input', () => sync(b.value));
}
['knockoutTolerance', 'edgeSoftness', 'cleanupIntensity', 'microDot', 'chokePx'].forEach((id) => syncInputs(id, id + 'Num'));
['levelsBlack', 'levelsMid', 'levelsWhite', 'levelsOutBlack', 'levelsOutWhite'].forEach((id) => syncInputs(id + 'Slider', id));

document.querySelectorAll('input[type=range], input[type=number]').forEach((el) => {
  const input = el as HTMLInputElement;
  input.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = parseFloat(input.step) || 1;
    const dir = e.deltaY < 0 ? 1 : -1;
    let val = parseFloat(input.value) + step * dir;
    if (!isNaN(parseFloat(input.min))) val = Math.max(parseFloat(input.min), val);
    if (!isNaN(parseFloat(input.max))) val = Math.min(parseFloat(input.max), val);
    input.value = val.toFixed(step < 1 ? 2 : 0);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
});

// ---------- histogram ----------
function drawHistogram(img: ImageBitmap) {
  const hCanvas = document.getElementById('histogramCanvas') as HTMLCanvasElement | null;
  if (!hCanvas) return;
  const rect = hCanvas.getBoundingClientRect();
  if (rect.width) { hCanvas.width = rect.width; hCanvas.height = rect.height; }
  const ctx = hCanvas.getContext('2d')!;
  const { hist } = lumaHistogram(sampleImage(img));
  const max = Math.max(1, ...hist);
  ctx.clearRect(0, 0, hCanvas.width, hCanvas.height);
  ctx.fillStyle = '#888';
  const barWidth = hCanvas.width / 256;
  for (let i = 0; i < 256; i++) {
    const h = (hist[i] / max) * hCanvas.height;
    ctx.fillRect(i * barWidth, hCanvas.height - h, barWidth, h);
  }
}

// ---------- loading ----------
function setSource(img: ImageBitmap) {
  source = img; srcWidth = img.width; srcHeight = img.height;
  pipeline.setImage(img);
  emptyState.classList.add('hidden');
  btnExport.disabled = false;
  $<HTMLDivElement>('pixelDimensions').textContent = `${srcWidth} × ${srcHeight} px`;
  showPrintSize();
  drawHistogram(img);
  update();
}

async function loadImage(file: File) {
  const isNewFile = file !== originalFile;
  originalFile = file;
  const img = await createImageBitmap(file, { premultiplyAlpha: 'none' });
  // New file: default to its true 300 DPI size.
  if (isNewFile || !printWidthIn) printWidthIn = img.width / TARGET_DPI;
  setSource(img);
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await loadImage(file);
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.background = 'rgba(6, 182, 212, 0.05)'; });
dropZone.addEventListener('dragleave', () => { dropZone.style.background = ''; });
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault(); dropZone.style.background = '';
  const file = e.dataTransfer?.files[0];
  if (file && file.type.startsWith('image/')) await loadImage(file);
});

// ---------- render ----------
function readParams(viewMode: number, dpi: number): PipelineParams {
  const lpi = parseFloat(inputs.patternScaleSelect.value);
  const angle = parseFloat(inputs.patternAngleInput.value) || 0;
  const pxScale = dpi / TARGET_DPI; // slider px are defined at 300 DPI
  const cleanup = parseFloat(inputs.cleanupIntensity.value);
  const cleanup300 = cleanup > 66 ? 2 : cleanup > 0 ? 1 : 0;
  const choke300 = parseFloat(inputs.chokePx.value) || 0;
  const num = (id: string, d: number) => { const v = parseFloat($<HTMLInputElement>(id).value); return isNaN(v) ? d : v; };

  return {
    shape: parseInt(inputs.halftoneShape.value),
    cellPx: dpi / lpi,
    angleRad: (angle * Math.PI) / 180,
    halftone: inputs.enableHalftone.checked,
    shirtColor: hexToRgb(inputs.shirtColor.value),
    knockoutTolerance: parseFloat(inputs.knockoutTolerance.value),
    edgeSoftness: parseFloat(inputs.edgeSoftness.value),
    microDot: parseFloat(inputs.microDot.value),
    cleanupRadius: cleanup300 ? Math.max(1, Math.round(cleanup300 * pxScale)) : 0,
    chokeRadius: Math.min(MAX_MORPH_RADIUS, Math.round(choke300 * pxScale)),
    viewMode,
    levelsBlack: num('levelsBlack', 0) / 255,
    levelsWhite: num('levelsWhite', 255) / 255,
    levelsMid: num('levelsMid', 1) || 1,
    levelsOutBlack: num('levelsOutBlack', 0) / 255,
    levelsOutWhite: num('levelsOutWhite', 255) / 255,
  };
}

function renderAt(viewMode: number): { w: number; h: number; dpi: number; capped: boolean } {
  const size = workSize();
  pipeline.setOutputSize(size.w, size.h);
  pipeline.render(readParams(viewMode, size.dpi));
  return size;
}

function updateNow(): void {
  if (!source || !(printWidthIn > 0)) return;
  renderAt(currentViewMode);
  schedulePreflight();
}

// One render per animation frame while dragging sliders.
let updateQueued = false;
function update(): void {
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(() => { updateQueued = false; updateNow(); });
}

// Preflight reads the whole ink buffer back from the GPU, so run it once the controls settle.
let preflightTimer = 0;
function schedulePreflight(): void {
  clearTimeout(preflightTimer);
  preflightTimer = window.setTimeout(calculatePreflight, 250);
}

function calculatePreflight() {
  if (!source) return;
  const size = workSize();
  const alpha = pipeline.readInkAlpha();
  let inkedPixels = 0, semiPixels = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a > 5) { inkedPixels++; if (a < 250) semiPixels++; }
  }

  // Size / resolution checks (validate.ts)
  const result = validate({
    srcWidth, srcHeight,
    printWidthIn, printHeightIn: printHeightIn(),
    targetDPI: TARGET_DPI,
    hasAlpha: inkedPixels < alpha.length, // the exported PNG has transparent areas
    maxFilmWidthIn: parseFloat(filmWidthInput.value) || 22,
  });
  const findings = [...result.findings];
  if (size.capped) {
    findings.push({ level: 'amber', message: `This size exceeds the GPU/memory limit — exporting at ${Math.round(size.dpi)} DPI (${size.w}×${size.h} px).` });
  }
  renderFindings(findings);
  exportBlocked = findings.some((f) => f.level === 'red');
  btnExport.disabled = exportBlocked;
  btnExport.title = exportBlocked ? findings.filter((f) => f.level === 'red').map((f) => f.message).join(' ') : '';

  const verdict = $<HTMLDivElement>('preflightVerdict');
  const detail = $<HTMLDivElement>('preflightDetail');
  if (inkedPixels === 0) {
    $<HTMLDivElement>('preflightScore').textContent = '—';
    verdict.textContent = 'Nothing to print';
    detail.textContent = 'Every pixel is knocked out. Lower the knockout tolerance or check the shirt color.';
    return;
  }
  const semiPercent = (semiPixels / inkedPixels) * 100;
  const score = Math.max(0, Math.round(100 - 10 * semiPercent));
  $<HTMLDivElement>('preflightScore').textContent = score.toString();
  verdict.textContent = semiPixels === 0 ? 'Clean edges, no haze' : 'Semi-transparent ink found';
  detail.textContent = semiPixels === 0
    ? 'Every inked pixel is fully solid.'
    : `${semiPercent.toFixed(1)}% of ink is semi-transparent (${semiPixels} px). Lower Edge softness for hard DTF edges.`;
}

document.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', update));

// ---------- export ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < u.length; i++) c = CRC_TABLE[(c ^ u[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** Re-write the PNG with exactly one pHYs (DPI) and one sRGB chunk right after IHDR. */
async function tagPNG(blob: Blob, dpi: number): Promise<Blob> {
  const u = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(u.buffer);
  const ppm = Math.round(dpi / 0.0254), phys = new Uint8Array(9), pv = new DataView(phys.buffer);
  pv.setUint32(0, ppm); pv.setUint32(4, ppm); phys[8] = 1; // unit: metre
  const parts: Uint8Array[] = [u.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= u.length) {
    const len = dv.getUint32(i), end = i + 12 + len;
    const type = String.fromCharCode(u[i + 4], u[i + 5], u[i + 6], u[i + 7]);
    if (!['pHYs', 'sRGB', 'iCCP', 'gAMA', 'cHRM'].includes(type)) parts.push(u.subarray(i, end));
    if (type === 'IHDR') parts.push(pngChunk('sRGB', new Uint8Array([0])), pngChunk('pHYs', phys));
    i = end;
  }
  return new Blob(parts as BlobPart[], { type: 'image/png' });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000); // revoking immediately can cancel the download
}

// "Generate DTF Output" (shown after the first click) runs the same export as the header button.
btnApply.addEventListener('click', () => {
  if (!source) { alert('Please load an image first.'); return; }
  if (exportBlocked) { alert(btnExport.title || 'Fix the red Image Size warnings before exporting.'); return; }
  btnExport.click();
});

btnExport.addEventListener('click', async () => {
  if (!source || exportBlocked) return;
  btnExport.disabled = true;
  try {
    const base = (originalFile?.name ?? 'design').replace(/\.[^.]+$/, '');
    // Always export the separation (color + real alpha), never the on-shirt preview.
    const size = renderAt(1);
    const dpi = Math.round(size.dpi);
    const tag = `${dpi}dpi-${fmt(printWidthIn)}x${fmt(printHeightIn())}in`;
    download(await tagPNG(await pipeline.toBlob(), dpi), `${base}-dtf-color-${tag}.png`);
    if (inputs.enableUnderbase.checked) {
      renderAt(2);
      download(await tagPNG(await pipeline.toBlob(), dpi), `${base}-underbase-${tag}.png`);
    }
  } catch (e) {
    console.error(e);
    alert('Export failed: ' + (e as Error).message);
  } finally {
    btnExport.disabled = exportBlocked;
    update(); // restore the on-screen view
  }
});
