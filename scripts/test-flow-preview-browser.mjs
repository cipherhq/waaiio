// Local browser regression: real builder + CSS, isolated API fixtures; no hosted writes.
// Run: node scripts/test-flow-preview-browser.mjs
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), 'flow-preview-browser-'));
const fixture = {
  id: 'preview-fixture', name: 'Preview fixture', status: 'draft', greeting: 'Welcome', fallback_message: 'Try again', start_node: 'menu',
  nodes: [
    { id: 'menu', type: 'menu', text: 'Choose information', options: [{ label: 'Schedule', next: 'lookup' }, { label: 'Vendors', next: 'lookup' }] },
    { id: 'lookup', type: 'lookup', table: 'artists', prompt: 'Type an artist name', search_fields: ['name'], reply: '{{name}}', next: 'menu' },
    { id: 'end', type: 'message', text: 'Finished', next: null },
  ],
};
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {FlowBuilder} from './components/custom-flows/FlowBuilder'; createRoot(document.getElementById('root')).render(<FlowBuilder businessId="fixture-business"/>);`;
await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', jsx: 'automatic', outfile: path.join(temp, 'app.js'), define: { 'process.env.NODE_ENV': '"development"' }, tsconfig: path.join(root, 'tsconfig.json') });
const css = await postcss([tailwind({ content: ['./components/custom-flows/**/*.{ts,tsx}'], theme: { extend: {} }, plugins: [] })]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined });
await writeFile(path.join(temp, 'app.css'), css.css);
const server = createServer(async (req, res) => {
  const file = req.url === '/app.js' ? 'app.js' : req.url === '/app.css' ? 'app.css' : null;
  res.setHeader('Content-Type', file === 'app.js' ? 'text/javascript' : file === 'app.css' ? 'text/css' : 'text/html');
  res.end(file ? await readFile(path.join(temp, file)) : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root" style="padding:16px"></div><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const calls = [];
    let releaseRequest;
    let delayNext = false;
    let failNext = false;
    const menu = { text: 'Choose information', options: [{ label: 'Schedule', value: 'cf:menu:0' }, { label: 'Vendors', value: 'cf:menu:1' }] };
    await page.route('**/api/custom-flows**', async route => {
      const request = route.request();
      if (request.method() === 'GET') return route.fulfill({ json: request.url().includes('/data') ? { tables: [], rows: [] } : { flows: [{ id: fixture.id, version: 1, definition: fixture, published_definition: null, published_version: null }] } });
      const body = request.postDataJSON(); calls.push(body);
      assert.equal(body.action, 'preview', 'Browser tests must never save or publish');
      if (delayNext) { delayNext = false; await new Promise(resolve => { releaseRequest = resolve; }); }
      if (failNext) { failNext = false; return route.fulfill({ status: 400, json: { error: 'preview_unavailable' } }); }
      const messages = [{ text: body.definition.greeting }, ...Array.from({ length: 14 }, (_, i) => ({ text: `Earlier information ${i}` })), menu, { text: 'Menu companion information' }];
      for (const input of body.inputs) {
        messages.push({ text: input, input: true });
        if (input.startsWith('cf:')) messages.push({ text: 'Type an artist name' });
        else messages.push({ text: 'Artist found' }, structuredClone(menu), { text: 'Returned menu companion' });
      }
      return route.fulfill({ json: { messages } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('combobox', { name: 'Custom flows', exact: true }).selectOption(fixture.id);
    await page.getByLabel('Greeting', { exact: true }).fill('Unsaved greeting retained');
    const preview = page.getByRole('complementary');
    const restart = preview.getByRole('button', { name: 'Restart preview' });
    const activate = async locator => mobile ? locator.tap() : locator.click();
    await activate(restart);
    const schedule = preview.getByRole('button', { name: 'Schedule', exact: true });
    await schedule.waitFor();
    const transcript = preview.locator('[aria-live="polite"]');
    const bottom = async () => transcript.evaluate(el => ({ remaining: el.scrollHeight - el.clientHeight - el.scrollTop, top: el.scrollTop }));
    await page.waitForFunction(() => { const el = document.querySelector('aside [aria-live="polite"]'); return el && el.scrollHeight - el.clientHeight - el.scrollTop < 2; });
    assert.ok((await bottom()).top > 0, 'Long transcript must scroll');
    await schedule.scrollIntoViewIfNeeded();
    if (!mobile) await schedule.focus();
    delayNext = true;
    if (mobile) await schedule.tap(); else await schedule.press('Enter');
    await page.waitForFunction(() => document.querySelector('aside button')?.disabled);
    const pageY = await page.evaluate(() => window.scrollY);
    assert.equal(await schedule.isDisabled(), true);
    releaseRequest();
    await preview.getByText('Type an artist name', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.scrollY), pageY, 'Response must not scroll the document');
    assert.ok((await bottom()).remaining < 2, 'Latest reply must be inside conversation viewport');
    assert.equal(await schedule.isDisabled(), true, 'Historical menu must stay disabled');
    const before = calls.length;
    await schedule.evaluate(el => el.click());
    assert.equal(calls.length, before, 'Historical buttons cannot send lookup searches');
    await preview.getByLabel('Message', { exact: true }).fill('Ada');
    await preview.getByRole('button', { name: 'Preview draft', exact: true }).click();
    await preview.getByText('Artist found', { exact: true }).waitFor();
    const menus = preview.getByRole('button', { name: 'Schedule', exact: true });
    assert.equal(await menus.first().isDisabled(), true);
    assert.equal(await menus.last().isEnabled(), true, 'Returning menu with companion text must work');
    await activate(restart);
    await page.waitForFunction(() => document.querySelectorAll('aside button').length === 4);
    assert.equal(await preview.getByRole('button', { name: 'Schedule', exact: true }).isEnabled(), true);
    failNext = true;
    await activate(preview.getByRole('button', { name: 'Vendors', exact: true }));
    const error = preview.getByText('Unable to preview this draft. Check the flow and try again.');
    await error.waitFor();
    assert.equal(await error.isVisible(), true);
    assert.equal(await page.getByLabel('Greeting', { exact: true }).inputValue(), 'Unsaved greeting retained');
    assert.ok(calls.every(call => call.definition.greeting === 'Unsaved greeting retained'));
    // Existing SDK: keyboard and pointer reorder remain draft-only and preserve menu edges.
    const items = page.locator('[data-slot="flow-block-order-item"]');
    const initial = await items.allTextContents();
    await items.nth(1).focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Space');
    assert.match((await items.allTextContents())[0], /Lookup/);
    await page.getByRole('button', { name: /^Move down: 1\./ }).click();
    assert.deepEqual(await items.allTextContents(), initial);
    await items.first().scrollIntoViewIfNeeded();
    const a = await items.first().boundingBox(); const b = await items.nth(1).boundingBox();
    if (mobile) {
      const session = await context.newCDPSession(page);
      const x = a.x + a.width / 2; const from = a.y + a.height / 2; const to = b.y + b.height - 2;
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
      for (let step = 1; step <= 15; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * step / 15 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height - 2, { steps: 15 }); await page.mouse.up();
    }
    assert.match((await items.allTextContents())[0], /Lookup/, 'Pointer drag must reorder');
    await activate(restart);
    await preview.getByRole('button', { name: 'Schedule', exact: true }).waitFor();
    assert.deepEqual(calls.at(-1).definition.nodes.find(node => node.id === 'menu').options, fixture.nodes[0].options);
    console.log(`${mobile ? 'mobile 390x844 touch' : 'desktop 1440x1000 keyboard'}: PASS scroll/history/return/restart/loading/error/dirty draft/reorder`);
    await context.close();
  }
} finally {
  await browser?.close(); server.close(); await rm(temp, { recursive: true, force: true });
}
