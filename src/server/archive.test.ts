import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractArchive, hoistSingleRoot, isArchiveName, safeJoin } from './archive.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'comb-archive-'));

/** Minimal stored (uncompressed) zip writer; the extractor ignores CRCs. */
function createZip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(0, 14); // crc
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + entry.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function createTar(entries: { name: string; data: string; dir?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '', 'utf8');
    parts.push(tarHeader(entry.name, entry.dir ? 0 : data.length, entry.dir ? '5' : '0'));
    if (!entry.dir) {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test('zip extraction writes files and unwraps a single top-level folder', () => {
  const dir = temp();
  const file = join(dir, 'connector.zip');
  writeFileSync(
    file,
    createZip([
      { name: 'my-connector-main/', data: Buffer.alloc(0) },
      { name: 'my-connector-main/package.json', data: Buffer.from('{"name":"x"}') },
      { name: 'my-connector-main/src/index.js', data: Buffer.from('console.log(1)') },
    ]),
  );

  const dest = join(dir, 'out');
  const result = extractArchive(file, dest);
  assert.equal(result.files, 2);
  assert.equal(hoistSingleRoot(dest), true);
  assert.ok(existsSync(join(dest, 'package.json')));
  assert.ok(existsSync(join(dest, 'src/index.js')));
  assert.equal(readFileSync(join(dest, 'package.json'), 'utf8'), '{"name":"x"}');
});

test('a tree with several top-level entries is left alone', () => {
  const dir = temp();
  const dest = join(dir, 'out');
  writeFileSync(
    join(dir, 'multi.zip'),
    createZip([
      { name: 'package.json', data: Buffer.from('{}') },
      { name: 'src/index.js', data: Buffer.from('x') },
    ]),
  );
  extractArchive(join(dir, 'multi.zip'), dest);
  assert.equal(hoistSingleRoot(dest), false);
  assert.ok(existsSync(join(dest, 'package.json')));
});

test('zip-slip entries are rejected and nothing is written outside the target', () => {
  const dir = temp();
  const dest = join(dir, 'nested', 'out');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(
    join(dir, 'evil.zip'),
    createZip([{ name: '../escaped.txt', data: Buffer.from('nope') }]),
  );

  assert.throws(() => extractArchive(join(dir, 'evil.zip'), dest), /path traversal blocked/);
  assert.equal(existsSync(join(dir, 'nested', 'escaped.txt')), false);
  assert.equal(existsSync(join(dir, 'escaped.txt')), false);
});

test('absolute entry paths are treated as traversal', () => {
  assert.throws(() => safeJoin('/tmp/root', '/etc/passwd'), /path traversal blocked/);
  assert.throws(() => safeJoin('/tmp/root', '../../etc/passwd'), /path traversal blocked/);
  assert.equal(safeJoin('/tmp/root', 'a/b.txt'), resolve('/tmp/root', 'a/b.txt'));
});

test('tar and tar.gz archives extract, including a wrapper folder', () => {
  const dir = temp();
  const tar = createTar([
    { name: 'proj/', data: '', dir: true },
    { name: 'proj/main.py', data: 'print(1)\n' },
    { name: 'proj/requirements.txt', data: 'fastapi\n' },
  ]);
  writeFileSync(join(dir, 'proj.tar'), tar);
  writeFileSync(join(dir, 'proj.tgz'), gzipSync(tar));

  for (const name of ['proj.tar', 'proj.tgz']) {
    const dest = join(dir, `out-${name.replace('.', '-')}`);
    extractArchive(join(dir, name), dest);
    assert.equal(hoistSingleRoot(dest), true, `${name} unwraps`);
    assert.ok(existsSync(join(dest, 'main.py')));
    assert.equal(readFileSync(join(dest, 'main.py'), 'utf8'), 'print(1)\n');
  }
});

test('tar-slip entries are rejected', () => {
  const dir = temp();
  writeFileSync(join(dir, 'evil.tar'), createTar([{ name: '../../escape.txt', data: 'x' }]));
  assert.throws(() => extractArchive(join(dir, 'evil.tar'), join(dir, 'out')), /path traversal blocked/);
});

test('archive names are recognised by extension', () => {
  for (const name of ['a.zip', 'a.tar.gz', 'a.tgz', 'a.tar', 'a.rar', 'a.7z']) {
    assert.equal(isArchiveName(name), true, name);
  }
  assert.equal(isArchiveName('a.exe'), false);
  assert.equal(isArchiveName('a.tar.bz2'), false);
});
