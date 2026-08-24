// Main-thread controller for the library scan worker.
//
// Owns the folder grant and the worker lifecycle. The worker does the walking,
// parsing, and index writing; this module only starts it, relays progress, and
// keeps the grant available across sessions.

import { getMeta, setMeta } from './store.mjs';

const GRANT_KEY = 'rootHandle';

export class GrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
  }
}

/** True when this browser can hold a directory grant at all (R1 storage path). */
export function supportsFolderGrant() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/** Ask for a music folder. Returns the handle, or null if the person cancelled. */
export async function requestFolder() {
  if (!supportsFolderGrant()) {
    throw new GrantError(
      'ERR_NAKLIAMP_NO_FOLDER_GRANT',
      'This browser cannot grant a folder. Open single tracks instead, or use a Chromium browser for the library.',
    );
  }
  try {
    const handle = await showDirectoryPicker({ id: 'nakliamp-library', mode: 'read' });
    await setMeta(GRANT_KEY, handle);
    return handle;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    throw error;
  }
}

/** The stored handle, or null when there is none. Does not prompt. */
export async function storedFolder() {
  return (await getMeta(GRANT_KEY)) ?? null;
}

/**
 * Whether the stored grant is still usable without prompting.
 * A grant revoked between sessions is the expected case, not an error.
 */
export async function grantState(handle) {
  if (!handle) return 'none';
  if (typeof handle.queryPermission !== 'function') return 'granted';
  return handle.queryPermission({ mode: 'read' });
}

/** Re-request an existing grant. Must be called from a user gesture. */
export async function reclaimFolder(handle) {
  if (!handle) return 'none';
  if (typeof handle.requestPermission !== 'function') return 'granted';
  return handle.requestPermission({ mode: 'read' });
}

export async function forgetFolder() {
  await setMeta(GRANT_KEY, null);
}

/**
 * Run a scan. Returns a controller with a `done` promise and a `cancel()`.
 * `onProgress` is called with the worker's own progress messages.
 */
export function startScan(rootHandle, { onProgress = () => {}, onFileError = () => {} } = {}) {
  const worker = new Worker(new URL('./scan-worker.mjs', import.meta.url), { type: 'module' });
  let settle;
  let fail;
  const done = new Promise((resolve, reject) => { settle = resolve; fail = reject; });

  worker.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'progress') onProgress(message);
    else if (message.type === 'file-error') onFileError(message);
    else if (message.type === 'done') { worker.terminate(); settle(message); }
    else if (message.type === 'error') {
      worker.terminate();
      const error = new Error(message.message);
      error.code = message.code;
      fail(error);
    }
  });
  worker.addEventListener('error', event => {
    worker.terminate();
    const error = new Error(event.message || 'The library scan worker failed to start.');
    error.code = 'ERR_NAKLIAMP_SCAN_WORKER';
    fail(error);
  });

  worker.postMessage({ type: 'scan', rootHandle });

  return {
    done,
    cancel() { worker.postMessage({ type: 'cancel' }); },
  };
}

/** The summary written by the last completed scan, or null. */
export async function lastScan() {
  return getMeta('lastScan');
}
