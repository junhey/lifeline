import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config.js';

function serviceVersionPath(): string {
  return join(CONFIG_DIR, 'service-version');
}

/** `null` when the file is missing or empty — that counts as a version mismatch. */
export function readServiceVersion(): string | null {
  try {
    const text = readFileSync(serviceVersionPath(), 'utf-8').trim();
    return text || null;
  }
  catch {
    return null;
  }
}

export function writeServiceVersion(version: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(serviceVersionPath(), version, 'utf-8');
}
