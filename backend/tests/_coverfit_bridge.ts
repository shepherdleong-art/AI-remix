/**
 * Bridge: expose the REAL src/renderer/utils/coverFit.ts computeCoverFit to
 * Python/pytest over JSON (stdin -> stdout). Used by the autofit regression
 * test so the e2e render assertion exercises the genuine frontend function,
 * not a reimplementation.
 *
 * Run:  echo '{...CoverFitInput}' | npx tsx backend/tests/_coverfit_bridge.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { computeCoverFit } from '../../src/renderer/utils/coverFit';

const raw = readFileSync(0, 'utf8');
const input = JSON.parse(raw);
const result = computeCoverFit(input);
writeFileSync(1, JSON.stringify(result));
