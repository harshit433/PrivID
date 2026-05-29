#!/usr/bin/env node
/**
 * 3DiVi Face SDK liveness check (Node.js API).
 * Usage: node threedivi-liveness.mjs <sdk_path> <modification> <image1.jpg> [image2.jpg ...]
 * Requires THREEDIVI_NODE_API_PATH or <sdk_path>/../node_js_api from face-sdk release.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const [sdkPath, modification, ...imagePaths] = process.argv.slice(2);

if (!sdkPath || !modification || imagePaths.length === 0) {
  console.error('Usage: threedivi-liveness.mjs <sdk_path> <modification> <image>...');
  process.exit(2);
}

const nodeApiPath =
  process.env.THREEDIVI_NODE_API_PATH?.trim() ||
  path.join(sdkPath, 'node_js_api');

const require = createRequire(import.meta.url);
const facerec = require(path.join(nodeApiPath, 'face_sdk_3divi.js'));

const dllPath = path.join(sdkPath, 'lib', process.platform === 'darwin' ? 'libfacerec.dylib' : 'libfacerec.so');
const confPath = path.join(sdkPath, 'conf', 'facerec');
const licensePath = path.join(sdkPath, 'license');

facerec.Init(dllPath, confPath, licensePath);

const detectorConfig = new facerec.Context();
detectorConfig.get('unit_type').value = 'FACE_DETECTOR';
detectorConfig.get('modification').value = 'ssyv_light';

const fitterConfig = new facerec.Context();
fitterConfig.get('unit_type').value = 'FACE_FITTER';

const livenessConfig = new facerec.Context();
livenessConfig.get('unit_type').value = 'LIVENESS_ESTIMATOR';
livenessConfig.get('modification').value = modification;

const detector = new facerec.ProcessingBlock(detectorConfig);
const fitter = new facerec.ProcessingBlock(fitterConfig);
const livenessEstimator = new facerec.ProcessingBlock(livenessConfig);

const minConfidence = Number(process.env.THREEDIVI_LIVENESS_MIN_CONFIDENCE ?? '0.5');

let best = { passed: false, verdict: 'UNKNOWN', confidence: 0, faces_detected: 0 };

for (const imagePath of imagePaths) {
  const buffer = fs.readFileSync(imagePath);
  const ioData = new facerec.Context(buffer);

  detector.process(ioData);
  const objects = ioData.get('objects');
  const faceCount = objects?.length ?? 0;

  if (faceCount !== 1) {
    continue;
  }

  fitter.process(ioData);
  livenessEstimator.process(ioData);

  const obj = objects[0];
  const liveness = obj.get('liveness');
  const verdict = liveness.get('value').value;
  const confidence = Number(liveness.get('confidence').value);
  const passed = verdict === 'REAL' && confidence >= minConfidence;

  if (passed && confidence > best.confidence) {
    best = { passed: true, verdict, confidence, faces_detected: 1 };
  } else if (!best.passed && confidence > best.confidence) {
    best = { passed, verdict, confidence, faces_detected: 1 };
  }
}

console.log(JSON.stringify(best));
process.exit(0);
