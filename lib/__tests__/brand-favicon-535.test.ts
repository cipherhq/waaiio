import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const brandSource = readFileSync(resolve(__dirname, '../brand.ts'), 'utf-8');

describe('#535 canonical Waaiio favicon', () => {
  it('uses the canonical square Waaiio icon as the browser favicon', () => {
    expect(brandSource).toContain("export const ICON_PATH = '/apple-touch-icon.png';");
    expect(brandSource).toContain('export const FAVICON_PATH = ICON_PATH;');
  });

  it('removes the stale Next.js app/favicon.ico override', () => {
    expect(existsSync(resolve(__dirname, '../../app/favicon.ico'))).toBe(false);
  });

  it('keeps the canonical square icon asset available', () => {
    expect(existsSync(resolve(__dirname, '../../public/apple-touch-icon.png'))).toBe(true);
  });
});
