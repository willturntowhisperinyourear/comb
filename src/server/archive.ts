import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync, gunzipSync } from 'node:zlib';

// Archive handling for custom connectors. zip and tar are parsed here so the
// path rules are enforced while files are written, not after. rar and 7z need
// a host extractor; their output is validated before it is used.

export const ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.tar', '.rar', '.7z'];

export const isArchiveName = (name: string) =>
  ARCHIVE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/** Resolves an archive entry inside root, rejecting absolute paths and .. escapes. */
export function safeJoin(root: string, entry: string): string {
  const cleaned = entry.replace(/\\/g, '/').replace(/\0/g, '');
  if (!cleaned.trim()) throw new Error('archive entry has an empty path');
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, cleaned);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new Error(`path traversal blocked: ${entry}`);
  }
  return target;
}

function writeEntry(root: string, entry: string, data: Buffer, isDir: boolean, count: { files: number; bytes: number }) {
  count.bytes += data.length;
  if (count.bytes > MAX_TOTAL_BYTES) throw new Error('archive expands past the 512 MB limit');
  if (++count.files > MAX_ENTRIES) throw new Error('archive has more than 20000 entries');
  const target = safeJoin(root, entry);
  if (isDir) {
    mkdirSync(target, { recursive: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data, { mode: 0o644 });
}

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttrs: number;
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  // End of central directory: scan backwards over the comment field.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive: end of central directory not found');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported; re-zip without zip64');
  }

  let offset = cdOffset;
  const entries: ZipEntry[] = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const flags = buf.readUInt16LE(offset + 8);
    const compression = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf
      .subarray(offset + 46, offset + 46 + nameLen)
      .toString(flags & 0x0800 ? 'utf8' : 'latin1');
    if (flags & 0x0001) throw new Error(`encrypted zip entry: ${name}`);
    entries.push({ name, compression, compressedSize, uncompressedSize, localOffset, externalAttrs });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZip(file: string, dest: string, notes: string[]) {
  const buf = readFileSync(file);
  const entries = readZipEntries(buf);
  const count = { files: 0, bytes: 0 };

  for (const entry of entries) {
    // Symlinks would let a later entry write outside the destination.
    if (((entry.externalAttrs >>> 16) & 0o170000) === 0o120000) {
      notes.push(`skipped symlink entry ${entry.name}`);
      continue;
    }
    const isDir = entry.name.endsWith('/');
    if (entry.localOffset + 30 > buf.length || buf.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw new Error(`corrupt zip local header for ${entry.name}`);
    }
    const nameLen = buf.readUInt16LE(entry.localOffset + 26);
    const extraLen = buf.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

    let data = Buffer.alloc(0);
    if (isDir) data = Buffer.alloc(0);
    else if (entry.compression === 0) data = raw;
    else if (entry.compression === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip compression ${entry.compression} for ${entry.name}`);

    writeEntry(dest, entry.name, data, isDir, count);
  }
  notes.push(`zip: ${count.files} entries`);
}

function readTarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

function parsePax(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of data.split('\n')) {
    const match = /^\d+ ([^=]+)=(.*)$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function extractTar(file: string, dest: string, notes: string[]) {
  let tar = readFileSync(file);
  const isGzip = file.toLowerCase().endsWith('.gz') || (tar[0] === 0x1f && tar[1] === 0x8b);
  if (isGzip) tar = gunzipSync(tar);

  const count = { files: 0, bytes: 0 };
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let skippedLinks = 0;

  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;

    const size = parseInt(readTarString(block, 124, 12) || '0', 8) || 0;
    const type = String.fromCharCode(block[156] || 0x30);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    let name = readTarString(block, 0, 100);
    const prefix = readTarString(block, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    if (type === 'L') longName = data.toString('utf8').replace(/\0+$/, '');
    else if (type === 'x') {
      const pax = parsePax(data.toString('utf8'));
      if (pax.path) paxPath = pax.path;
    } else if (type === '2' || type === '1') {
      skippedLinks++;
      notes.push(`skipped link entry ${name}`);
    } else {
      const finalName = paxPath ?? longName ?? name;
      if (finalName) {
        const isDir = type === '5' || finalName.endsWith('/');
        writeEntry(dest, finalName, isDir ? Buffer.alloc(0) : Buffer.from(data), isDir, count);
      }
      longName = null;
      paxPath = null;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (skippedLinks) notes.push(`tar: ${skippedLinks} links skipped`);
  notes.push(`tar: ${count.files} entries`);
}

const which = (bin: string): boolean => {
  const res = spawnSync('/bin/bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  return res.status === 0 && !!res.stdout.trim();
};

const UNWRAP_SKIP = new Set(['__MACOSX', '.DS_Store', '.git']);

function findExternalExtractor(ext: '.rar' | '.7z'): { bin: string; args: (file: string, dest: string) => string[] } | null {
  const candidates = ext === '.rar' ? ['unrar', 'unar', '7z', '7zz', '7za', 'bsdtar'] : ['7z', '7zz', '7za', 'bsdtar'];
  for (const bin of candidates) {
    if (!which(bin)) continue;
    if (bin === 'unrar') return { bin, args: (file, dest) => ['x', '-o+', '-y', file, dest + '/'] };
    if (bin === 'unar') return { bin, args: (file, dest) => ['-o', dest, '-f', file] };
    if (bin === 'bsdtar') return { bin, args: (file, dest) => ['-xf', file, '-C', dest] };
    return { bin, args: (file, dest) => ['x', '-y', `-o${dest}`, file] };
  }
  return null;
}

function validateTree(root: string, notes: string[]) {
  let files = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        unlinkSync(full);
        notes.push(`skipped symlink ${entry.name}`);
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else {
        const real = resolve(full);
        if (!real.startsWith(resolve(root) + sep)) throw new Error(`extractor wrote outside the staging dir: ${full}`);
        files++;
      }
    }
  };
  walk(root);
  return files;
}

function extractWithHostTool(file: string, dest: string, ext: '.rar' | '.7z', notes: string[]) {
  const tool = findExternalExtractor(ext);
  if (!tool) {
    throw new Error(
      `no extractor for ${ext} on this host. Install one of: ` +
        (ext === '.rar' ? 'unrar, unar, p7zip (7z) or bsdtar' : 'p7zip (7z/7zz/7za) or bsdtar'),
    );
  }
  mkdirSync(dest, { recursive: true });
  const res = spawnSync(tool.bin, tool.args(file, dest), { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${tool.bin} failed: ${(res.stderr || res.stdout || 'unknown error').slice(0, 400)}`);
  }
  const files = validateTree(dest, notes);
  notes.push(`${tool.bin}: ${files} files`);
}

/** Extracts an archive into dest, enforcing the path rules for every entry. */
export function extractArchive(file: string, dest: string): { files: number; notes: string[] } {
  mkdirSync(dest, { recursive: true });
  const notes: string[] = [];
  const lower = file.toLowerCase();

  if (lower.endsWith('.zip')) extractZip(file, dest, notes);
  else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    extractTar(file, dest, notes);
  } else if (lower.endsWith('.rar')) extractWithHostTool(file, dest, '.rar', notes);
  else if (lower.endsWith('.7z')) extractWithHostTool(file, dest, '.7z', notes);
  else throw new Error(`unsupported archive type: ${file}`);

  // Hide packaging noise so detection sees the real project root.
  for (const junk of UNWRAP_SKIP) rmSync(join(dest, junk), { recursive: true, force: true });

  return { files: countFiles(dest), notes };
}

export function countFiles(root: string): number {
  if (!existsSync(root)) return 0;
  let files = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else files++;
    }
  };
  walk(root);
  return files;
}

/**
 * Zip and tar archives usually wrap everything in one folder. Hoist that
 * folder's contents to the root so the install command runs where expected.
 */
export function hoistSingleRoot(root: string): boolean {
  let entries = readdirSync(root).filter((e) => !UNWRAP_SKIP.has(e));
  if (entries.length !== 1) return false;
  const only = join(root, entries[0]);
  if (!lstatSync(only).isDirectory()) return false;
  if (readdirSync(only).length === 0) return false;

  for (const child of readdirSync(only)) renameSync(join(only, child), join(root, child));
  rmSync(only, { recursive: true, force: true });
  entries = readdirSync(root);
  return entries.length > 0;
}
