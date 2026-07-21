/**
 * Unit tests for coverFit.ts — pure-function checks for `computeCoverFit`.
 *
 * Run with:  npx tsx src/renderer/utils/coverFit.test.ts
 *
 * These exercise the DETERMINISTIC, DOM-free core so they do not depend on a
 * browser or on ffmpeg. `measureText`/`fitTitleLine` (which touch the DOM) are
 * covered separately by the QA render regression, not here.
 */
import assert from 'node:assert/strict';
import { computeCoverFit } from './coverFit';

const approx = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  \u2717 ${name}`);
    console.error('    ' + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

// 9:16 export canvas, 4% safe margin (matches ExportConfirm / backend).
const base = { canvasW: 1080, canvasH: 1920, safeMargin: 0.04 } as const;
// fitW = canvasW * (1 - 2*safeMargin) = 1080 * 0.92 = 993.6
// fitH = canvasH * (1 - 2*safeMargin) = 1920 * 0.92 = 1766.4
// marginPx = 0.04 * 1080 = 43.2 ; marginPxV = 0.04 * 1920 = 76.8

test('no adjustment when text fits and anchor centered', () => {
  const r = computeCoverFit({ ...base, measuredWidth: 200, measuredHeight: 0, fontSize: 48, titleX: 50, titleY: 35 });
  assert.equal(r.adjusted, false);
  assert.equal(r.didShrink, false);
  assert.equal(r.fontSize, 48);
  assert.equal(r.titleX, 50);
  assert.equal(r.titleY, 35);
});

test('nudge keeps a short-of-full-width title inside when its anchor would clip (no shrink)', () => {
  // width 900 fits within the full safe width (1036.8) so it is NOT shrunk.
  // At titleX=20% the left edge would be clipped, so the anchor is nudged right
  // just enough to keep the whole line inside (left edge -> marginPx = 43.2px).
  // cx = 20%*1080 = 216; halfW = 450; nudged cx = 43.2 + 450 = 493.2 -> 45.6667%
  const r = computeCoverFit({ ...base, measuredWidth: 900, measuredHeight: 0, fontSize: 48, titleX: 20, titleY: 35 });
  assert.equal(r.adjusted, true);
  assert.equal(r.didShrink, false);
  assert.equal(r.fontSize, 48, 'font size preserved when only nudging');
  assert.ok(approx(r.titleX, (493.2 / 1080) * 100), `titleX=${r.titleX}`);
  assert.equal(r.titleY, 35);
});

test('nudge honours the nearer edge for an off-center right anchor (no shrink)', () => {
  // width 600 fits the full safe width, no shrink. At titleX=80% the right edge
  // would clip, so the anchor nudges left to keep the line inside.
  // cx = 80%*1080 = 864; halfW = 300; right edge 1164 > 1036.8 -> cx = 1036.8-300 = 736.8 -> 68.2222%
  const r = computeCoverFit({ ...base, measuredWidth: 600, measuredHeight: 0, fontSize: 48, titleX: 80, titleY: 35 });
  assert.equal(r.didShrink, false);
  assert.equal(r.adjusted, true);
  assert.ok(approx(r.titleX, (736.8 / 1080) * 100), `titleX=${r.titleX}`);
});

test('shrink when text wider than the full safe width even when centered', () => {
  // width 2000 -> exceeds fitW (993.6) => must shrink to fit the full frame.
  const r = computeCoverFit({ ...base, measuredWidth: 2000, measuredHeight: 0, fontSize: 48, titleX: 50, titleY: 35 });
  assert.equal(r.didShrink, true);
  assert.equal(r.titleX, 50);
  assert.equal(r.adjusted, true);
  // factor = (fitW/totalW) * 0.98 = (993.6/2000)*0.98 = 0.486864; 48 * 0.486864 = 23.369
  assert.ok(approx(r.fontSize, 48 * (993.6 / 2000) * 0.98), `fontSize=${r.fontSize}`);
});

test('shrink to fit the full frame for extremely wide text (no hard floor)', () => {
  // width 5000 exceeds fitW by a lot -> shrink factor = (993.6/5000)*0.98 = 0.194746
  // -> 48 * 0.194746 = 9.348 (the line must actually fit, so no maxShrink cap).
  const r = computeCoverFit({ ...base, measuredWidth: 5000, measuredHeight: 0, fontSize: 48, titleX: 50, titleY: 35 });
  assert.equal(r.didShrink, true);
  assert.ok(approx(r.fontSize, 48 * (993.6 / 5000) * 0.98, 1e-4), `fontSize=${r.fontSize}`);
  assert.equal(r.titleX, 50);
});

test('nudge keeps a tall-but-fitting title inside when its anchor would clip (no shrink)', () => {
  // height 1500 fits within safeH (1843.2) so it is NOT shrunk. At titleY=20%
  // the top edge would clip, so the anchor nudges down to keep the line inside.
  // cy = 20%*1920 = 384; halfH = 750; nudged cy = 76.8 + 750 = 826.8 -> 43.0625%
  const r = computeCoverFit({ ...base, measuredWidth: 100, measuredHeight: 1500, fontSize: 48, titleX: 50, titleY: 20 });
  assert.equal(r.adjusted, true);
  assert.equal(r.didShrink, false);
  assert.equal(r.titleX, 50);
  assert.ok(approx(r.titleY, (826.8 / 1920) * 100), `titleY=${r.titleY}`);
});

test('no vertical adjustment for a short, centered title', () => {
  const r = computeCoverFit({ ...base, measuredWidth: 100, measuredHeight: 40, fontSize: 48, titleX: 50, titleY: 35 });
  assert.equal(r.adjusted, false);
  assert.equal(r.titleY, 35);
});

test('original values returned unchanged when no adjustment', () => {
  const r = computeCoverFit({ ...base, measuredWidth: 100, measuredHeight: 40, fontSize: 48, titleX: 50, titleY: 35 });
  assert.deepEqual(
    { fontSize: r.fontSize, titleX: r.titleX, titleY: r.titleY },
    { fontSize: 48, titleX: 50, titleY: 35 },
  );
});

console.log(`\ncomputeCoverFit: ${passed} passed, ${failed} failed`);
