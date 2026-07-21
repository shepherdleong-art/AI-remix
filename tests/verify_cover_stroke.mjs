// verify_cover_stroke.mjs
// Frontend regression check for Bug 2 (export stroke scales with font size).
//   1) Replicates the ExportConfirm.tsx formula and asserts the numeric mapping.
//   2) Statically reads ExportConfirm.tsx to prove the SOURCE still uses
//      `* COVER_SCALE` for the stroke fields (guards against a regression that
//      would drop the scaling).
//
// Run:  node tests/verify_cover_stroke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src/renderer/components/render/ExportConfirm.tsx');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${detail ? ' -- ' + detail : ''}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`);
  }
}

// ---- (1) Replicate the formula from ExportConfirm.tsx ----
const COVER_SCALE = 1920 / 320; // must equal 6, matching title_size/sub_size
const round = (x) => Math.round(x);

check('COVER_SCALE == 6', COVER_SCALE === 6, `COVER_SCALE=${COVER_SCALE}`);

// stroke width mapping (the exported borderw feeding ffmpeg)
check('w=2 -> 12', round(2 * COVER_SCALE) === 12, `got ${round(2 * COVER_SCALE)}`);
check('w=0 -> 0', round(0 * COVER_SCALE) === 0, `got ${round(0 * COVER_SCALE)}`);
check('w=8 -> 48', round(8 * COVER_SCALE) === 48, `got ${round(8 * COVER_SCALE)}`);

// stroke and font size use the SAME constant -> exported stroke ratio == preview stroke ratio
// preview:  WebkitTextStroke: `${ctsw}px`
// export:   borderw = round(ctsw * COVER_SCALE);  title size = round(cts * COVER_SCALE)
// ratio is identical -> visually consistent.
const previewTitlePx = 48; // example preview font size
const exportTitlePx = round(previewTitlePx * COVER_SCALE); // = 288
const previewStroke = 2;
const exportStroke = round(previewStroke * COVER_SCALE); // = 12
const previewRatio = previewStroke / previewTitlePx; // 2/48 = 0.0416
const exportRatio = exportStroke / exportTitlePx; // 12/288 = 0.0416
check(
  'stroke/font-size ratio identical in preview and export',
  Math.abs(previewRatio - exportRatio) < 1e-9,
  `preview=${previewRatio.toFixed(4)} export=${exportRatio.toFixed(4)}`,
);

// ---- (2) Static source guard ----
const src = readFileSync(SRC, 'utf8');
const lines = src.split('\n');
const idx = (substr) => lines.findIndex((l) => l.includes(substr));

const iConst = lines.findIndex((l) => l.trim().startsWith('const COVER_SCALE'));
const iStrokeTitle = lines.findIndex(
  (l) => l.includes('title_stroke_width:') && l.includes('* COVER_SCALE'),
);
const iStrokeSub = lines.findIndex(
  (l) => l.includes('sub_stroke_width:') && l.includes('* COVER_SCALE'),
);
const iTitleSize = lines.findIndex(
  (l) => l.includes('title_size:') && l.includes('* COVER_SCALE'),
);
const iSubSize = lines.findIndex(
  (l) => l.includes('sub_size:') && l.includes('* COVER_SCALE'),
);

check('source: COVER_SCALE constant defined', iConst >= 0, `line ${iConst + 1}`);
check('source: title_stroke_width uses * COVER_SCALE', iStrokeTitle >= 0, `line ${iStrokeTitle + 1}`);
check('source: sub_stroke_width uses * COVER_SCALE', iStrokeSub >= 0, `line ${iStrokeSub + 1}`);
check('source: title_size uses * COVER_SCALE (same constant)', iTitleSize >= 0, `line ${iTitleSize + 1}`);
check('source: sub_size uses * COVER_SCALE (same constant)', iSubSize >= 0, `line ${iSubSize + 1}`);

// The ORIGINAL bug was scaling stroke by resolution.height; make sure it's gone.
const bugPattern = /stroke_width:\s*Math\.round\([^)]*resolution\.height/i;
check('source: stroke does NOT scale by resolution.height', !bugPattern.test(src));

console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
