/**
 * coverFit.ts — Cover title WYSIWYG + smart anti-cropping helpers (Plan B+).
 *
 * Goal: make the step-3 cover preview render the SAME title geometry that the
 * export (ffmpeg drawtext) will burn — "what you see is what you get" — and
 * auto-protect over-wide / over-tall titles from being clipped at the cover
 * edges.
 *
 * Two layers:
 *  1. `measureTextWidth` / `measureText` — measure real rendered glyph metrics
 *     with a hidden DOM <span>. This is more reliable than canvas.measureText
 *     because it uses the exact same font the browser will paint (no font-load
 *     timing pitfalls), so the measured width matches the preview 1:1.
 *  2. `computeCoverFit` — a PURE function (no DOM access) that, given a measured
 *     text size, the user's chosen font size + anchor (titleX/titleY in %), and
 *     the canvas dimensions, returns the final font size + anchor that keep the
 *     text inside a safe margin. It prefers SHIFTING the anchor (preserving the
 *     user's font size); it only SHRINKS the font when even a centered anchor
 *     would still overflow. Purity makes it trivially unit-testable.
 *  3. `fitTitleLine` — convenience: measure one title line then compute fit.
 *
 * The same function is used on BOTH sides:
 *  - Preview (TimelineEditor): measure at preview px, canvas = preview box.
 *  - Export (ExportConfirm): measure at EXPORT px (coverTitleSize * COVER_SCALE),
 *    canvas = export resolution, then title_size = effectiveFontSize * COVER_SCALE.
 * Because every quantity scales linearly by COVER_SCALE, the preview and export
 * produce identical relative adjustments → WYSIWYG.
 */

export type FontStyle = 'normal' | 'italic';

export interface MeasureTextOptions {
  /** Font size in px (the size the text is rendered at for the measurement). */
  fontSize: number;
  /** CSS font-family name (must match the preview/export font). */
  fontFamily: string;
  /** CSS font-weight (e.g. 800 for the title, 600 for the subtitle). */
  fontWeight?: number | string;
  /** CSS font-style. */
  fontStyle?: FontStyle;
}

export interface TextMetrics {
  /** Rendered glyph advance width in px (float). */
  width: number;
  /** Line-box height in px (float). */
  height: number;
}

/**
 * Measure the real rendered size of `text` using a hidden DOM <span>.
 *
 * The span uses `position:absolute; visibility:hidden; white-space:nowrap;
 * maxWidth:none` with the SAME font-family / font-size / font-weight / font-style
 * as the target, so we read the exact glyph metrics the browser will paint.
 * Returns a float width/height via getBoundingClientRect (sub-pixel accurate;
 * the conceptual approach in the spec is the hidden-span `scrollWidth`).
 *
 * Safe in non-DOM environments (returns a rough fallback) so the module can be
 * imported in tests/SSR without throwing.
 */
export function measureText(text: string, opts: MeasureTextOptions): TextMetrics {
  if (typeof document === 'undefined' || !document.body) {
    // Fallback estimate for non-browser contexts (keeps the module importable).
    return {
      width: (text ?? '').length * opts.fontSize * 0.6,
      height: opts.fontSize * 1.2,
    };
  }
  const span = document.createElement('span');
  span.textContent = text;
  span.style.position = 'absolute';
  span.style.left = '-99999px';
  span.style.top = '0px';
  span.style.visibility = 'hidden';
  span.style.whiteSpace = 'nowrap';
  span.style.maxWidth = 'none';
  span.style.display = 'inline-block';
  span.style.fontFamily = opts.fontFamily;
  span.style.fontSize = `${opts.fontSize}px`;
  span.style.fontWeight = String(opts.fontWeight ?? 'normal');
  span.style.fontStyle = opts.fontStyle ?? 'normal';
  span.style.lineHeight = 'normal';
  span.style.letterSpacing = 'normal';
  document.body.appendChild(span);
  const rect = span.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  document.body.removeChild(span);
  return { width, height };
}

/** Convenience: measured glyph width only (number), per the spec signature. */
export function measureTextWidth(text: string, opts: MeasureTextOptions): number {
  return measureText(text, opts).width;
}

export interface CoverFitInput {
  /** Measured rendered width of the text, in canvas px. */
  measuredWidth: number;
  /** Measured rendered height of the text, in canvas px (0 = skip vertical check). */
  measuredHeight?: number;
  /** Base (user-chosen) font size in px — the shrink factor is relative to this. */
  fontSize: number;
  /** Horizontal anchor center, percent 0–100. */
  titleX: number;
  /** Vertical anchor center, percent 0–100. */
  titleY: number;
  /** Canvas (export) width in px. */
  canvasW: number;
  /** Canvas (export) height in px. */
  canvasH: number;
  /** Fraction of canvas reserved as a safe margin on each side (default 0.04). */
  safeMargin?: number;
  /** Minimum allowed font-size multiplier (default 0.5). */
  maxShrink?: number;
  /** Stroke (border) width in canvas px, added on BOTH sides of the glyphs.
   *  Must match what ffmpeg's `borderw` draws so the preview fit equals the
   *  export fit (ffmpeg adds `borderw` px per side; the DOM <span> used for
   *  measuring has no stroke, so without this the preview under-estimates the
   *  real line width and can disagree with the export). */
  strokeWidth?: number;
}

export interface CoverFitResult {
  /** Effective font size (px); equal to `fontSize` unless shrunk. */
  fontSize: number;
  /** Final horizontal anchor center, percent 0–100. */
  titleX: number;
  /** Final vertical anchor center, percent 0–100. */
  titleY: number;
  /** True if any adjustment (shift or shrink) was applied. */
  adjusted: boolean;
  /** True if the font size was shrunk (vs. only shifted). */
  didShrink: boolean;
}

/**
 * Compute the final title geometry that keeps the text inside a safe margin.
 *
 * Pure function — no DOM, no side effects — so it is trivially unit-testable.
 *
 * Strategy (per product rule — the title is treated as a single, non-wrapping
 * line; `totalW`/`totalH` already include the ffmpeg stroke width):
 *  - The SHRINK trigger is the WHOLE cover width/height, NOT the half-space from
 *    the anchor. So a title shorter than the cover width is kept at its full size
 *    — it is never shrunk just because it is placed off-centre.
 *  - Only when the title genuinely EXCEEDS the cover width/height do we SHRINK the
 *    font (uniformly) until the single line fits the full frame, and re-centre the
 *    axis that overflowed (x=50 / y=50).
 *  - When the title fits the frame but its anchor would still push part of it past
 *    an edge, the anchor is NUDGED minimally (kept as close to the user's
 *    placement as possible) so it never clips. The font size is preserved.
 *  - If nothing overflows and the anchor is already inside, returns the original
 *    values with `adjusted = false`.
 */
export function computeCoverFit(input: CoverFitInput): CoverFitResult {
  const {
    measuredWidth,
    measuredHeight = 0,
    fontSize,
    titleX,
    titleY,
    canvasW,
    canvasH,
    safeMargin = 0.04,
    strokeWidth = 0,
  } = input;

  let effectiveFontSize = fontSize;
  let finalX = titleX;
  let finalY = titleY;
  let adjusted = false;
  let didShrink = false;

  // Real line extents PER SIDE, including the ffmpeg stroke (borderw) which
  // paints `strokeWidth` px on BOTH sides of every glyph. The DOM <span> used
  // for measuring has no stroke, so we add it here to match the export's real
  // line width — this is the root cause of the old "preview fit but export
  // clipped" bug.
  const totalW = measuredWidth + 2 * strokeWidth;
  const totalH = measuredHeight + 2 * strokeWidth;
  const halfW = totalW / 2;
  const halfH = totalH / 2;

  // Shrink when the title exceeds the available width MINUS both margins.
  // We need room on BOTH sides to nudge without clipping.  The old check
  // (`halfW > safeW/2` <=> `totalW > canvasW*(1-margin)`) was too loose:
  // when totalW is between canvasW*(1-2*margin) and canvasW*(1-margin),
  // the nudge `else if` could only correct one edge at a time, so the
  // opposite edge remained clipped and distorted the centroid.  Using the
  // tighter `canvasW*(1-2*margin)` bound guarantees there is always enough
  // room for a safe nudge on BOTH axes.
  const fitW = canvasW * (1 - 2 * safeMargin);
  const fitH = canvasH * (1 - 2 * safeMargin);
  const shrinkX = totalW > fitW;
  const shrinkY = totalH > fitH;
  if (shrinkX || shrinkY) {
    // Shrink until the single line fits the full frame (no wrap). The same
    // factor applies to width and height because the font scales uniformly.
    // A 0.98 guard eats the floor()+proportional-to-actual rounding gap so
    // the shrunk line never barely-touches the edge after truncation.
    let factor = 1;
    if (shrinkX) factor = Math.min(factor, (fitW / totalW) * 0.98);
    if (shrinkY) factor = Math.min(factor, (fitH / totalH) * 0.98);
    // A tiny floor avoids a 0px / invisible title for pathological inputs.
    effectiveFontSize = Math.max(fontSize * factor, 1);
    finalX = shrinkX ? 50 : titleX;
    finalY = shrinkY ? 50 : titleY;
    didShrink = true;
    adjusted = true;
  } else {
    // Fits the frame: keep the font size, NUDGE the anchor minimally so it stays
    // inside (only when an edge would otherwise be clipped).  Uses `if` (not
    // `else if`) for left+right / top+bottom so that when both edges overflow
    // the second correction still runs (the last write wins, at least keeping
    // the text anchored to the nearer edge instead of silently clipping it).
    const marginPx = safeMargin * canvasW;
    const marginPxV = safeMargin * canvasH;
    let cx = (titleX / 100) * canvasW;
    let cy = (titleY / 100) * canvasH;
    if (cx - halfW < marginPx) cx = marginPx + halfW;
    if (cx + halfW > canvasW - marginPx) cx = canvasW - marginPx - halfW;
    if (cy - halfH < marginPxV) cy = marginPxV + halfH;
    if (cy + halfH > canvasH - marginPxV) cy = canvasH - marginPxV - halfH;
    finalX = (cx / canvasW) * 100;
    finalY = (cy / canvasH) * 100;
    adjusted = Math.abs(finalX - titleX) > 1e-6 || Math.abs(finalY - titleY) > 1e-6;
  }

  return {
    fontSize: effectiveFontSize,
    titleX: finalX,
    titleY: finalY,
    adjusted,
    didShrink,
  };
}

export interface FitTitleLineStyle {
  fontFamily?: string;
  fontWeight?: number | string;
  fontStyle?: FontStyle;
}

export interface FitTitleLineOptions {
  fontSize: number;
  titleX: number;
  titleY: number;
  canvasW: number;
  canvasH: number;
  safeMargin?: number;
  maxShrink?: number;
  strokeWidth?: number;
}

/**
 * Measure a single title line at `opts.fontSize` and run `computeCoverFit`.
 *
 * Use this on the PREVIEW side (measure at preview px, canvas = preview box).
 * For the EXPORT side, measure at export px and call `computeCoverFit` directly
 * so the shrink factor is computed against the export base size.
 */
export function fitTitleLine(
  text: string,
  style: FitTitleLineStyle,
  opts: FitTitleLineOptions,
): CoverFitResult {
  const metrics = measureText(text, {
    fontSize: opts.fontSize,
    fontFamily: style.fontFamily ?? 'sans-serif',
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
  });
  return computeCoverFit({
    measuredWidth: metrics.width,
    measuredHeight: metrics.height,
    fontSize: opts.fontSize,
    titleX: opts.titleX,
    titleY: opts.titleY,
    canvasW: opts.canvasW,
    canvasH: opts.canvasH,
    safeMargin: opts.safeMargin,
    maxShrink: opts.maxShrink,
    strokeWidth: opts.strokeWidth,
  });
}
