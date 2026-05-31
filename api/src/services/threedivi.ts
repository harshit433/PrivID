import fs from 'fs';
import path from 'path';

function hasLicenseFile(sdkPath: string): boolean {
  const licenseDir = path.join(sdkPath, 'license');
  if (!fs.existsSync(licenseDir)) return false;
  return fs.readdirSync(licenseDir).some((name) => name.endsWith('.lic'));
}

/** Used by /health to report whether the 3DiVi SDK is present on this host. */
export function isThreediviConfigured(): boolean {
  const sdkPath = process.env.THREEDIVI_SDK_PATH?.trim();
  if (!sdkPath) return false;
  const libDir = path.join(sdkPath, 'lib');
  return fs.existsSync(path.join(libDir, 'libfacerec.so')) && hasLicenseFile(sdkPath);
}
