#!/usr/bin/env node
/*
  Patch script to replace deprecated fs.F_OK with fs.constants.F_OK
  in react-dev-utils/checkRequiredFiles.js used by react-scripts 5.
  Safe to run multiple times; no-op if already patched or file missing.
*/
const fs = require('fs');
const path = require('path');

function patchFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const src = fs.readFileSync(filePath, 'utf8');
    if (!src.includes('fs.F_OK')) return false; // already patched or different version
    const out = src.replace(/fs\.F_OK/g, 'fs.constants.F_OK');
    if (out !== src) {
      fs.writeFileSync(filePath, out, 'utf8');
      console.log(`[patch] Applied fs.constants.F_OK change in ${filePath}`);
      return true;
    }
  } catch (e) {
    console.warn(`[patch] Failed to patch ${filePath}:`, e && e.message);
  }
  return false;
}

function main() {
  const root = process.cwd();
  const target = path.join(root, 'node_modules', 'react-dev-utils', 'checkRequiredFiles.js');
  const ok = patchFile(target);
  if (!ok) {
    // Try Yarn PnP or alternative layout? Nothing to do if not found.
    // Not a fatal error.
    // console.log('[patch] No fs.F_OK occurrence found or file missing.');
  }
}

main();
