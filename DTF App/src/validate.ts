export type Level = 'green' | 'amber' | 'red';
export interface Finding {
  level: Level;
  message: string;
}

export interface ValidationInput {
  srcWidth: number;
  srcHeight: number;
  printWidthIn: number;
  printHeightIn: number;
  targetDPI: number;
  hasAlpha: boolean;
  maxFilmWidthIn: number;
}

export interface ValidationResult {
  findings: Finding[];
  effectiveDPI: number;
  printIn: { w: number; h: number };
}

export type Unit = 'in' | 'mm' | 'cm';

export function toInches(value: number, unit: Unit): number {
  if (unit === 'in') return value;
  if (unit === 'mm') return value / 25.4;
  return value / 2.54;
}

export function fromInches(inches: number, unit: Unit): number {
  if (unit === 'in') return inches;
  if (unit === 'mm') return inches * 25.4;
  return inches * 2.54;
}

export function validate(input: ValidationInput): ValidationResult {
  const findings: Finding[] = [];
  const { srcWidth, srcHeight, printWidthIn, printHeightIn, targetDPI } = input;

  const wIn = printWidthIn;
  const hIn = printHeightIn;
  const dpiX = srcWidth / wIn;
  const dpiY = srcHeight / hIn;
  const effectiveDPI = Math.min(dpiX, dpiY);

  if (!isFinite(effectiveDPI) || effectiveDPI <= 0) {
    findings.push({ level: 'red', message: 'Invalid print dimensions.' });
    return { findings, effectiveDPI: 0, printIn: { w: wIn, h: hIn } };
  }

  if (effectiveDPI >= 300) {
    findings.push({ level: 'green', message: `Ready for print — ${effectiveDPI.toFixed(0)} DPI.` });
  } else if (effectiveDPI >= 150) {
    findings.push({
      level: 'amber',
      message: `Below 300 DPI (${effectiveDPI.toFixed(0)}). Fine for photos, soft for line art.`,
    });
  } else if (effectiveDPI >= 72) {
    findings.push({
      level: 'amber',
      message: `Too low for DTF (${effectiveDPI.toFixed(0)} DPI). Increase resolution or reduce print size.`,
    });
  } else {
    findings.push({
      level: 'red',
      message: `Below minimum (${effectiveDPI.toFixed(0)} DPI). Cannot export.`,
    });
  }

  const upscale = Math.max((wIn * targetDPI) / srcWidth, (hIn * targetDPI) / srcHeight);
  if (upscale > 2) {
    findings.push({
      level: 'amber',
      message: `Upscaling ×${upscale.toFixed(1)} — detail will be lost.`,
    });
  }

  if (wIn > input.maxFilmWidthIn) {
    findings.push({
      level: 'red',
      message: `Print width ${wIn.toFixed(2)}″ exceeds film width ${input.maxFilmWidthIn}″.`,
    });
  }

  if (!input.hasAlpha) {
    findings.push({
      level: 'amber',
      message: 'No transparency detected — DTF/DTG needs a transparent background.',
    });
  }

  findings.push({
    level: 'green',
    message: `${srcWidth}×${srcHeight} px → ${wIn.toFixed(2)}″ × ${hIn.toFixed(2)}″ at ${targetDPI} DPI`,
  });

  return { findings, effectiveDPI, printIn: { w: wIn, h: hIn } };
}