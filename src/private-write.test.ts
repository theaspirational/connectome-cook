import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateWrite } from './private-write.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cook-private-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const oldFile = () => writeFileSync(join(root, 'token'), 'old', { mode: 0o600 });
const intact = () => {
  expect(readFileSync(join(root, 'token'), 'utf8')).toBe('old');
  expect(readdirSync(root).filter(n => n.startsWith('.cook-private-'))).toEqual([]);
};

test('creates and replaces a single private file with exact bytes and mode', () => {
  const refreshed = join(root, 'refresh.json');
  writeFileSync(refreshed, 'updated externally');
  const before = statSync(refreshed);
  expect(privateWrite(root, 'token', 'first')).toEqual({ durability: 'synced' });
  const ino = statSync(join(root, 'token')).ino;
  privateWrite(root, 'token', new Uint8Array([0, 10, 255]));
  expect(readFileSync(join(root, 'token'))).toEqual(Buffer.from([0, 10, 255]));
  expect(statSync(join(root, 'token')).ino).not.toBe(ino);
  expect(statSync(join(root, 'token')).mode & 0o7777).toBe(0o600);
  expect(statSync(refreshed).ino).toBe(before.ino);
  expect(readFileSync(refreshed, 'utf8')).toBe('updated externally');
});

test('supports declared read-only mode, independent of umask', () => {
  const mask = process.umask(0o777);
  try { privateWrite(root, 'token', 'new', { mode: 0o400 }); }
  finally { process.umask(mask); }
  expect(statSync(join(root, 'token')).mode & 0o7777).toBe(0o400);
});

for (const path of ['../token', 'nested/../token', '/token', 'bad\0token', './token', 'a//token', 'a\\token', 'token/', '']) {
  test(`rejects noncanonical relative path ${JSON.stringify(path)}`, () => {
    oldFile(); expect(() => privateWrite(root, path, 'new')).toThrow(); intact();
  });
}

test('refuses symlink ancestors and a symlink root without following them', () => {
  mkdirSync(join(root, 'real'), { mode: 0o700 });
  symlinkSync('real', join(root, 'alias'));
  expect(() => privateWrite(root, 'alias/token', 'new')).toThrow();
  expect(() => privateWrite(join(root, 'alias'), 'token', 'new')).toThrow();
  mkdirSync(join(root, 'real/deep'), { mode: 0o700 });
  expect(() => privateWrite(join(root, 'alias/deep'), 'token', 'new')).toThrow();
  expect(readdirSync(join(root, 'real'))).toEqual(['deep']);
});

test('refuses symlink, directory and hardlinked targets even with tightening', () => {
  oldFile(); linkSync(join(root, 'token'), join(root, 'linked'));
  expect(() => privateWrite(root, 'token', 'new', { allowTightening: true })).toThrow(); intact();
  symlinkSync('token', join(root, 'alias'));
  expect(() => privateWrite(root, 'alias', 'new')).toThrow();
  mkdirSync(join(root, 'directory'), { mode: 0o700 });
  expect(() => privateWrite(root, 'directory', 'new')).toThrow();
});

test('refuses wrong existing owner using injected stat', () => {
  oldFile();
  expect(() => privateWrite(root, 'token', 'new', { allowTightening: true, test: { stat: path => {
    const s = lstatSync(path);
    if (path.endsWith('/token')) s.uid = (process.geteuid?.() ?? 0) + 1;
    return s;
  } } })).toThrow('E_PRIVATE_OWNER');
  intact();
});

for (const mode of [0o644, 0o640, 0o660, 0o700, 0o4600]) {
  test(`refuses existing mode ${mode.toString(8)} unless explicitly tightened`, () => {
    oldFile(); chmodSync(join(root, 'token'), mode);
    expect(() => privateWrite(root, 'token', 'new')).toThrow('E_PRIVATE_MODE'); intact();
    privateWrite(root, 'token', 'new', { allowTightening: true });
    expect(readFileSync(join(root, 'token'), 'utf8')).toBe('new');
    expect(statSync(join(root, 'token')).mode & 0o7777).toBe(0o600);
  });
}

test('tightening cannot add permissions and invalid declared modes refuse', () => {
  oldFile(); chmodSync(join(root, 'token'), 0o400);
  expect(() => privateWrite(root, 'token', 'new', { allowTightening: true })).toThrow();
  expect(() => privateWrite(root, 'token', 'new', { mode: 0o644 as 0o600 })).toThrow(); intact();
});

test('requires existing private parent directories, never creates them', () => {
  expect(() => privateWrite(root, 'missing/token', 'new')).toThrow();
  mkdirSync(join(root, 'public'), { mode: 0o755 });
  expect(() => privateWrite(root, 'public/token', 'new')).toThrow();
  chmodSync(root, 0o755);
  expect(() => privateWrite(root, 'token', 'new')).toThrow();
  expect(readdirSync(root)).toEqual(['public']);
});

for (const point of ['created', 'written', 'file-synced'] as const) {
  test(`failure at ${point} preserves old bytes and removes only its temp`, () => {
    oldFile(); writeFileSync(join(root, '.cook-private-other'), 'unrelated');
    expect(() => privateWrite(root, 'token', 'new', { test: { point: p => { if (p === point) throw new Error('injected'); } } })).toThrow('E_PRIVATE_IO');
    expect(readFileSync(join(root, 'token'), 'utf8')).toBe('old');
    expect(readdirSync(root).sort()).toEqual(['.cook-private-other', 'token']);
  });
}

test('partial write failure leaves old file and no temp', () => {
  oldFile(); let calls = 0;
  expect(() => privateWrite(root, 'token', 'new value', { test: { write: (fd, bytes, offset) => {
    if (calls++) throw new Error('interrupted');
    return writeSync(fd, bytes, offset, 2);
  } } })).toThrow(); intact();
});

test('loops on short writes; syncs the file before rename and directory after', () => {
  oldFile(); const seen: string[] = [];
  const result = privateWrite(root, 'token', 'new value', { test: {
    write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, Math.min(length, 2)),
    sync: fd => { seen.push(readFileSync(join(root, 'token'), 'utf8')); fsyncSync(fd); },
  } });
  expect(seen).toEqual(['old', 'new value']); expect(result.durability).toBe('synced');
});

test('file fsync failure is pre-commit and preserves old content', () => {
  oldFile();
  expect(() => privateWrite(root, 'token', 'new', { test: { sync: () => { throw new Error('sync failed'); } } })).toThrow(); intact();
});

test('post-rename directory sync failure reports committed, uncertain durability', () => {
  oldFile(); let calls = 0;
  expect(privateWrite(root, 'token', 'new', { test: { sync: fd => {
    if (calls++) throw new Error('sync failed'); fsyncSync(fd);
  } } })).toEqual({ durability: 'uncertain' });
  expect(readFileSync(join(root, 'token'), 'utf8')).toBe('new');
  expect(readdirSync(root)).toEqual(['token']);
});

test('rechecks the target before committing so concurrent replacement is preserved', () => {
  oldFile();
  expect(() => privateWrite(root, 'token', 'new', { test: { point: p => {
    if (p === 'written') {
      writeFileSync(join(root, 'other'), 'external', { mode: 0o600 });
      renameSync(join(root, 'other'), join(root, 'token'));
    }
  } } })).toThrow();
  expect(readFileSync(join(root, 'token'), 'utf8')).toBe('external');
  expect(readdirSync(root)).toEqual(['token']);
});

test('directory descriptors prevent a replaced ancestor from redirecting writes', () => {
  mkdirSync(join(root, 'parent'), { mode: 0o700 });
  mkdirSync(join(root, 'outside'), { mode: 0o700 });
  privateWrite(root, 'parent/token', 'new', { test: { point: p => {
    if (p === 'written') {
      renameSync(join(root, 'parent'), join(root, 'original'));
      symlinkSync('outside', join(root, 'parent'));
    }
  } } });
  expect(readdirSync(join(root, 'outside'))).toEqual([]);
  expect(readFileSync(join(root, 'original/token'), 'utf8')).toBe('new');
});
