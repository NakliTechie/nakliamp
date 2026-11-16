// In-memory fakes of File System Access and OPFS handles for the review-a tests.

/** A fake FileSystemFileHandle: commits on close, bumps lastModified. */
export function fakeFile(name, bytes, { lastModified = 1000 } = {}) {
  const state = { bytes, lastModified, writes: 0 };
  return {
    kind: 'file',
    name,
    state,
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return new File([state.bytes], name, { lastModified: state.lastModified }); },
    async createWritable() {
      const chunks = [];
      return {
        async write(data) { chunks.push(new Uint8Array(await new Blob([data]).arrayBuffer())); },
        async close() {
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const out = new Uint8Array(total);
          let cursor = 0;
          for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.length; }
          state.bytes = out;
          state.lastModified += 1;
          state.writes += 1;
        },
        async abort() {},
      };
    },
  };
}

/** A fake FileSystemDirectoryHandle with entries(), files and subdirectories. */
export function fakeDirectory() {
  const files = new Map();
  const directories = new Map();
  const log = [];
  return {
    kind: 'directory',
    files,
    directories,
    log,
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!directories.has(name)) {
        if (!create) throw new DOMException('missing', 'NotFoundError');
        directories.set(name, fakeDirectory());
      }
      return directories.get(name);
    },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException('missing', 'NotFoundError');
        files.set(name, fakeFile(name, new Uint8Array(0)));
        log.push(`create ${name}`);
      }
      return files.get(name);
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError');
      log.push(`remove ${name}`);
    },
    async *entries() {
      for (const [name, handle] of files) yield [name, handle];
      for (const [name, handle] of directories) yield [name, handle];
    },
  };
}
