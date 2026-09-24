import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetsBeside, consoleAssets } from '../src/console.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-console-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('assetsBeside', () => {
  it('acha o dist com index.html ao lado do package.json', async () => {
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'index.html'), '<!doctype html>');
    expect(assetsBeside(join(dir, 'package.json'))).toBe(join(dir, 'dist'));
  });

  it('undefined sem build', () => {
    expect(assetsBeside(join(dir, 'package.json'))).toBeUndefined();
  });
});

describe('consoleAssets', () => {
  it('acha o build do @ebb/console do workspace', () => {
    // O `npm test` builda antes, então o dist existe.
    expect(consoleAssets()).toMatch(/apps[/\\]console[/\\]dist$/);
  });
});
