// How far the chrome's colored marks stand off what they are drawn on, ported
// from herdr-gpui's `contrast.rs`. Status colors are picked for a dark UI and
// fade on light themes; `ink` keeps a color's hue and moves only its lightness
// until it reaches a WCAG contrast ratio. Terminal cells never come here: a
// program's colors reach the screen as it asked.

/// Marks reach 3:1, the WCAG minimum for meaningful graphics.
export const MARK_RATIO = 3;
/// Anything that can be words reaches 4.5:1, the WCAG minimum for small text.
export const TEXT_RATIO = 4.5;

function channels(color: number): [number, number, number] {
  return [16, 8, 0].map((shift) => ((color >> shift) & 255) / 255) as [number, number, number];
}

function pack(rgb: number[]): number {
  return rgb.reduce((packed, channel) => packed * 256 + Math.round(Math.min(1, Math.max(0, channel)) * 255), 0);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/// WCAG relative luminance.
export function luminance(color: number): number {
  const [r, g, b] = channels(color).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/// WCAG contrast ratio, from 1 (identical) to 21 (black on white).
export function ratio(a: number, b: number): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function worst(color: number, backgrounds: number[]): number {
  return Math.min(...backgrounds.map((background) => ratio(color, background)));
}

function toOklab(color: number): [number, number, number] {
  const [r, g, b] = channels(color).map(toLinear);
  const l = Math.cbrt(0.41222146 * r + 0.53633255 * g + 0.051445995 * b);
  const m = Math.cbrt(0.2119035 * r + 0.6806995 * g + 0.10739696 * b);
  const s = Math.cbrt(0.08830246 * r + 0.28171885 * g + 0.6299787 * b);
  return [
    0.21045426 * l + 0.7936178 * m - 0.004072047 * s,
    1.9779985 * l - 2.4285922 * m + 0.4505937 * s,
    0.025904037 * l + 0.78277177 * m - 0.80867577 * s,
  ];
}

/// Out-of-gamut results are clipped per channel; the caller measures what it gets back.
function fromOklab([lightness, a, b]: [number, number, number]): number {
  const l = (lightness + 0.39633778 * a + 0.21580376 * b) ** 3;
  const m = (lightness - 0.105561346 * a - 0.06385417 * b) ** 3;
  const s = (lightness - 0.08948418 * a - 1.2914855 * b) ** 3;
  return pack(
    [
      4.0767417 * l - 3.3077116 * m + 0.23096994 * s,
      -1.268438 * l + 2.6097574 * m - 0.34131938 * s,
      -0.0041960863 * l - 0.7034186 * m + 1.7076147 * s,
    ].map((c) => fromLinear(Math.min(1, Math.max(0, c)))),
  );
}

/// Pastels moved far from their lightness turn to mud unless they gain some
/// colorfulness on the way, so chroma grows with the distance travelled.
const CHROMA_GAIN = 1.5;
/// Bisection steps over OKLab lightness; well below one 8-bit step.
const STEPS = 16;

/// `color` with its lightness moved just far enough to reach `target` against
/// every one of `backgrounds`, keeping its hue. A color that already passes
/// comes back unchanged. Moves toward black on light chrome and toward white
/// on dark chrome; a target the chrome cannot allow ends at that pole.
export function ink(color: number, backgrounds: number[], target = MARK_RATIO): number {
  if (worst(color, backgrounds) >= target) return color;
  const darken = worst(0x000000, backgrounds) >= worst(0xffffff, backgrounds);
  const pole = darken ? 0x000000 : 0xffffff;
  const [lightness, a, b] = toOklab(color);
  const span = darken ? lightness : 1 - lightness;
  if (span <= Number.EPSILON) return pole;
  // `near` fails and `far` passes: close in on the least movement that passes.
  let [near, far] = [lightness, darken ? 0 : 1];
  let found = pole;
  for (let i = 0; i < STEPS; i++) {
    const middle = (near + far) / 2;
    const gain = 1 + (CHROMA_GAIN * Math.abs(middle - lightness)) / span;
    const candidate = fromOklab([middle, a * gain, b * gain]);
    if (worst(candidate, backgrounds) >= target) {
      found = candidate;
      far = middle;
    } else {
      near = middle;
    }
  }
  return found;
}
