import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ThreediviLivenessResult {
  passed: boolean;
  verdict: string;
  confidence: number;
  facesDetected: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVENESS_SCRIPT_NODE = path.join(__dirname, '../scripts/threedivi-liveness.mjs');
const LIVENESS_SCRIPT_PY = path.join(__dirname, '../scripts/threedivi-liveness.py');

function hasLicenseFile(sdkPath: string): boolean {
  const licenseDir = path.join(sdkPath, 'license');
  if (!fs.existsSync(licenseDir)) return false;
  return fs.readdirSync(licenseDir).some((name) => name.endsWith('.lic'));
}

export function isThreediviConfigured(): boolean {
  const sdkPath = process.env.THREEDIVI_SDK_PATH?.trim();
  if (!sdkPath) return false;
  const libDir = path.join(sdkPath, 'lib');
  return fs.existsSync(path.join(libDir, 'libfacerec.so')) && hasLicenseFile(sdkPath);
}

function nodePrebuildExists(sdkPath: string): boolean {
  const prebuild = path.join(
    sdkPath,
    'node_js_api',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'face_sdk_3divi.node'
  );
  return fs.existsSync(prebuild);
}

function resolveLivenessRunner(sdkPath: string): 'node' | 'python' {
  const forced = process.env.THREEDIVI_RUNNER?.trim().toLowerCase();
  if (forced === 'node' || forced === 'python') return forced;
  return nodePrebuildExists(sdkPath) ? 'node' : 'python';
}

function runScript(imagePaths: string[]): Promise<ThreediviLivenessResult> {
  const sdkPath = process.env.THREEDIVI_SDK_PATH!.trim();
  const modification = process.env.THREEDIVI_LIVENESS_MODIFICATION ?? '2d_light';
  const runner = resolveLivenessRunner(sdkPath);

  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [path.join(sdkPath, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  };

  const script = runner === 'python' ? LIVENESS_SCRIPT_PY : LIVENESS_SCRIPT_NODE;
  const cmd = runner === 'python' ? 'python3' : process.execPath;
  const args = [script, sdkPath, modification, ...imagePaths];

  if (runner === 'node' && process.env.THREEDIVI_NODE_API_PATH) {
    env.THREEDIVI_NODE_API_PATH = process.env.THREEDIVI_NODE_API_PATH;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `3DiVi liveness (${runner}) exited ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as ThreediviLivenessResult & {
          passed: boolean;
          verdict: string;
          confidence: number;
          faces_detected?: number;
        };
        resolve({
          passed: parsed.passed,
          verdict: parsed.verdict,
          confidence: parsed.confidence,
          facesDetected: parsed.faces_detected ?? parsed.facesDetected ?? 0,
        });
      } catch {
        reject(new Error(`Invalid 3DiVi script output: ${stdout}`));
      }
    });
  });
}

/** Run 3DiVi LIVENESS_ESTIMATOR on one or more JPEG buffers (best frame wins). */
export async function verifyLivenessFromImages(images: Buffer[]): Promise<ThreediviLivenessResult> {
  if (!isThreediviConfigured()) {
    return { passed: true, verdict: 'REAL', confidence: 1, facesDetected: 1 };
  }

  if (images.length === 0) {
    throw Object.assign(new Error('At least one face capture is required.'), { code: 'NO_CAPTURES' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privid-liveness-'));
  const paths: string[] = [];
  try {
    images.forEach((buf, i) => {
      const p = path.join(tmpDir, `capture_${i}.jpg`);
      fs.writeFileSync(p, buf);
      paths.push(p);
    });
    return await runScript(paths);
  } finally {
    for (const p of paths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}
