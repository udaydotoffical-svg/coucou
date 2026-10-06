// The main colour of an album cover, for tinting the music player.

export type RGB = [number, number, number];

/** What the player wears when there is no cover, or it has no colour of its own. */
export const DEFAULT_COLOR: RGB = [99, 102, 241];

const cache = new Map<string, RGB>();

function toHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function fromHsl(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Brightens and saturates a cover colour just enough to read on the dark island. */
function tidy(color: RGB): RGB {
  const [h, s, l] = toHsl(color);
  return fromHsl(h, s < 0.12 ? s : Math.max(s, 0.5), Math.min(0.66, Math.max(0.5, l)));
}

/**
 * The most vivid colour of the cover: a small copy is sampled, near-black and grey
 * pixels are ignored, and the hue that carries the most saturation wins. A cover with
 * no colour at all (greyscale) gives a soft light grey.
 */
export function dominantColor(src: string): Promise<RGB> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  return new Promise<RGB>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = 32;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return resolve(DEFAULT_COLOR);
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      let r0 = 0, g0 = 0, b0 = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        r0 += r; g0 += g; b0 += b; n++;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const v = max / 255;
        const s = max === 0 ? 0 : (max - min) / max;
        if (v < 0.18 || s < 0.2) continue;
        const [h] = toHsl([r, g, b]);
        const w = s * s * (0.4 + v);
        const k = Math.floor(h / 30) % 12;
        buckets[k].w += w; buckets[k].r += r * w; buckets[k].g += g * w; buckets[k].b += b * w;
      }
      const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
      const color: RGB =
        best.w > 0.5
          ? [best.r / best.w, best.g / best.w, best.b / best.w]
          : n > 0 ? [r0 / n, g0 / n, b0 / n] : DEFAULT_COLOR;
      resolve(tidy(color));
    };
    img.onerror = () => resolve(DEFAULT_COLOR);
    img.src = src;
  }).then((c) => {
    cache.set(src, c);
    if (cache.size > 12) cache.delete(cache.keys().next().value as string);
    return c;
  });
}

/** The three values the player's styles use: the colour, a lighter one for text on dark, and ink for text on it. */
export function palette(c: RGB): { p: string; light: string; ink: string } {
  const light = c.map((v) => Math.round(v + (255 - v) * 0.35));
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return { p: c.join(" "), light: light.join(" "), ink: lum > 0.55 ? "11 12 14" : "255 255 255" };
}
