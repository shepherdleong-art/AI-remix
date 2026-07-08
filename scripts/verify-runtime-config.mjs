import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

const electronMainPath = path.join(rootDir, 'dist-electron/main/index.js');
const electronConstantsPath = path.join(rootDir, 'dist-electron/main/constants.js');

assert.ok(
  existsSync(electronMainPath),
  `Electron main bundle should exist: ${electronMainPath}`
);

assert.ok(
  existsSync(electronConstantsPath),
  `Electron constants bundle should exist: ${electronConstantsPath}`
);

const constantsModule = require(electronConstantsPath);

assert.ok(
  existsSync(constantsModule.PYTHON_EXECUTABLE),
  `Python executable should exist: ${constantsModule.PYTHON_EXECUTABLE}`
);

const pythonOutput = execFileSync(
  path.join(rootDir, 'backend/venv/bin/python'),
  [
    '-c',
    'from config import FFMPEG_EXECUTABLE, FFPROBE_EXECUTABLE; import json, os; print(json.dumps({"ffmpeg": FFMPEG_EXECUTABLE, "ffmpeg_exists": os.path.isfile(FFMPEG_EXECUTABLE), "ffmpeg_executable": os.access(FFMPEG_EXECUTABLE, os.X_OK), "ffprobe": FFPROBE_EXECUTABLE, "ffprobe_exists": os.path.isfile(FFPROBE_EXECUTABLE), "ffprobe_executable": os.access(FFPROBE_EXECUTABLE, os.X_OK)}))',
  ],
  {
    cwd: path.join(rootDir, 'backend'),
    encoding: 'utf8',
  }
);

const pythonConfig = JSON.parse(pythonOutput);

assert.equal(
  pythonConfig.ffmpeg_exists,
  true,
  `FFmpeg executable should exist: ${pythonConfig.ffmpeg}`
);

assert.equal(
  pythonConfig.ffmpeg_executable,
  true,
  `FFmpeg file should be executable: ${pythonConfig.ffmpeg}`
);

assert.equal(
  pythonConfig.ffprobe_exists,
  true,
  `FFprobe executable should exist: ${pythonConfig.ffprobe}`
);

assert.equal(
  pythonConfig.ffprobe_executable,
  true,
  `FFprobe file should be executable: ${pythonConfig.ffprobe}`
);

execFileSync(pythonConfig.ffmpeg, ['-version'], { stdio: 'ignore' });
execFileSync(pythonConfig.ffprobe, ['-version'], { stdio: 'ignore' });
