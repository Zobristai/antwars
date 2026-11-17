/** Offline design evidence only. No server, account, key or external request. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createMatch } from '../../src/sim/map.ts';
import { rulesConfig } from '../../src/sim/config.ts';
import { newMatchConfig } from '../../src/sim/gridScale.ts';
import { quadrantMatchMaps } from '../../src/sim/mapShapes.ts';
import { step } from '../../src/sim/step.ts';
import { SpectatorRecorder } from '../../src/live/model.ts';
import { encodePublicMessage } from '../../src/live/format.ts';
import { packMessages } from '../../src/live/snapshot.ts';
import { servePage, checkRenderer, launchBrowser } from './browser.ts';
const variant = process.argv[2] ?? 'head';
const font = process.argv[3] ?? 'Liberation-Sans';
const output = resolve('out/result-directions'); mkdirSync(output, { recursive: true });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['web/src/ui/deck/result-modal.ts','web/src/ui/deck/deck.css'];
const sourceDigests = Object.fromEntries(sourcePaths.map(p => [p, digest(readFileSync(p))]));
const buildManifestDigest = digest(readFileSync(variant === 'before' ? 'out/result-baseline/.vite/manifest.json' : 'web/dist/.vite/manifest.json'));
const records: unknown[] = [];
const browser = await launchBrowser();
try {
  for (const scenario of ['two-rated', 'two-unrated', 'four-unrated']) {
    const count = scenario === 'four-unrated' ? 4 : 2;
    const rated = scenario === 'two-rated';
    const base = newMatchConfig(rulesConfig('redesign'));
    const config = count === 4 ? { ...base, terrain: { ...base.terrain!, maps: quadrantMatchMaps() } } : base;
    let state = createMatch(7001, config);
    for (let t = 0; t < 120; t++) state = step(state, []).state;
    const recorder = new SpectatorRecorder(state, { rated });
    const full = recorder.initialFull();
    const names = ['Gemini 4 Carbon (low)', 'Claude Fable 5.2 (low)', 'Mistral Large (high)', 'GPT 5.1 (medium)'];
    full.agents = Array.from({ length: count }, (_, colony) => ({ colony, identity: { displayName: names[colony], elo: [1488, 1849, 1602, 1534][colony] }, modelLabel: '', joinTick: 0, lastCallTick: 4098, prevCallTick: 4080, order: 'follow_trail', orderX: 0, orderY: 0, intent: '' }));
    if (count === 4) { full.queens = full.queens!.map(q => q.colony < 2 ? { ...q, hp: 0, lostTick: 3800 + q.colony * 100 } : q); full.eliminations = [{colony:0,tick:3800,reason:'queens_killed'},{colony:1,tick:3900,reason:'queens_killed'}] as any; }
    const winner = count === 2 ? 1 : 3;
    const loser = count === 2 ? 0 : 2;
    const target = full.queens!.find(q => q.colony === loser)!;
    const result = { winner, reason: 'queens_killed', decidedBy: 'queens_killed', tick: 4100, nextStartMs: null,
      ratingChanges: full.agents.map((_, agent) => ({ agent, before: [1488, 1849, 1602, 1534][agent], after: [1488, 1849, 1602, 1534][agent] + (agent === winner ? 18 : -6) })) };
    if (!rated) delete (result as any).ratingChanges;
    const initial = { ...recorder.initial(), tick: 4099, full };
    const attack = { ...recorder.initial(), tick: 4100, full: null, events: [{ kind: 'queenHp', colony: loser, queenId: target.id, hp: 1 }] };
    const finish = { ...recorder.initial(), tick: 4101, full: null, events: [{ kind: 'queenLost', queen: { ...target, hp: 0, lostTick: 4100 } }, { kind: 'end', result }] };
    const bytes = packMessages([initial, attack, finish, ...Array.from({length:30},(_,i)=>({...recorder.initial(),tick:4102+i,full:null,events:[]}))].map(m => encodePublicMessage(m as any)));
    const fixtureName = `${scenario}.bin`; writeFileSync(join(output, fixtureName), bytes);
    for (const width of [1280, 390]) {
      const served = await servePage(browser, { recording: '', replay: true, stored: { id: '2026-11-17T03-00-00-000Z-1', bytes, lastTick: 4131 }, board: '3d', width, height: width === 1280 ? 900 : 844, tilt: false, phone: width === 390, webDir: variant === 'before' ? resolve('out/result-baseline') : undefined });
      const missing: string[] = [];
      served.page.on('response', response => { if(response.status()===404) missing.push(new URL(response.url()).pathname); });
      await served.page.context().route('**/*', route => new URL(route.request().url()).origin === 'http://localhost:4718' ? route.fallback() : route.abort());
      await served.page.context().route('**/watch/ratings/*', route => route.fulfill({contentType:'application/json',body:JSON.stringify({ratings:[]})}));
      await served.page.goto(served.url);
      await served.page.waitForFunction(() => !!window.__antwar);
      const info = await served.page.evaluate(() => window.__antwar.ready);
      if(!info.webgl2 || checkRenderer(info.rendererString)) throw new Error('WebGL2/SwiftShader not established');
      const c = { ...served, info, advance:(ms:number)=>served.page.clock.runFor(ms), frame:()=>served.page.evaluate(()=>window.__antwar.frame()), close:()=>served.page.context().close() };
      try {
        // All remote traffic is refused, including analytics. The local route serves only fixture bytes/assets.
        await c.page.context().route(/^(?!http:\/\/localhost:4718\/).*/, r => r.abort());
        for (let i = 0; i < 20; i++) { await c.advance(500); await c.frame(); }
        await c.page.evaluate(() => document.fonts.ready);
        const dialog = c.page.locator('.d1-result-dialog[open]');
        if (!await dialog.count()) throw new Error('Result not open: ' + JSON.stringify(await c.page.evaluate(() => ({ b: window.__antwar.board(), r: window.__antwar.recording() }))));
        const measured = await c.page.evaluate(() => {
          const card = document.querySelector<HTMLElement>('.d1-result-dialog')!;
          const b = card.getBoundingClientRect();
          const selectors = '.d1-rating-name, .rd-colony, .rd-numbers, .rd-eyebrow, .rd-winner-name, .rd-outcome, .rd-label, .d1-result-next, .d1-share, .d1-moment-what, .d1-moment-who, .d1-result-how, .d1-when, .d1-tag, .rd-note, .d1-result-head:not(:has(span))';
          const labels = [...card.querySelectorAll<HTMLElement>(selectors)].filter(e => e.checkVisibility()).map(e => {
            const range = document.createRange(); range.selectNodeContents(e);
            const rects = [...range.getClientRects()].filter(r => r.width && r.height);
            const box = e.getBoundingClientRect();
            const style = getComputedStyle(e);
            const textBox = range.getBoundingClientRect();
            const spareFraction = box.width ? (box.width - textBox.width) / box.width : null;
            return { spareFraction, textWidth: textBox.width, text: e.textContent, className:e.className, fontFamily:style.fontFamily, fontSize:parseFloat(style.fontSize), lineHeight:style.lineHeight, lines: rects.length === 0 ? 0 : rects.every(r => r.top < Math.min(...rects.map(v => v.bottom)) && r.bottom > Math.max(...rects.map(v => v.top))) ? 1 : 2, clipped: e.scrollWidth > e.clientWidth + 1 || box.left < b.left || box.right > b.right + 1,
              box: { x: box.x, y: box.y, width: box.width, height: box.height } };
          });
          const overlaps: string[] = [];
          labels.forEach((a,i) => labels.slice(i+1).forEach(b => { const x = Math.min(a.box.x+a.box.width,b.box.x+b.box.width)-Math.max(a.box.x,b.box.x); const y = Math.min(a.box.y+a.box.height,b.box.y+b.box.height)-Math.max(a.box.y,b.box.y); if(x>1 && y>1) overlaps.push(`${a.text} / ${b.text}`); }));
          const textEdges = (e:Element) => { const range = document.createRange();range.selectNodeContents(e);const b=range.getBoundingClientRect();return {left:b.left,right:b.right}; };
          const alignments = ['rating','change'].flatMap(kind => {
            const header=card.querySelector(`.rd-${kind}-label`);
            if(!header || !header.checkVisibility()) return [];
            const edge=innerWidth<=600 && kind==='rating' ? 'left' : 'right';
            const headerEdge=textEdges(header)[edge];
            const values=[...card.querySelectorAll(kind==='rating'?'.rd-numbers':'.rd-change')].map(e=>textEdges(e)[edge]);
            return [{column:kind,edge,header:headerEdge,values,maxDifference:Math.max(0,...values.map(v=>Math.abs(v-headerEdge)))}];
          });
          return { alignments, card: { x:b.x,y:b.y,width:b.width,height:b.height, scroll:card.scrollHeight>card.clientHeight+1 }, labels, overlaps, text:card.innerText, font:getComputedStyle(card).fontFamily, withinViewport:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight };
        });
        const cdp = await c.page.context().newCDPSession(c.page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
        const {root} = await cdp.send('DOM.getDocument'); const {nodeIds} = await cdp.send('DOM.querySelectorAll', {nodeId:root.nodeId,selector:'.rd-winner-name, .rd-outcome, .d1-result-head:not(:has(span)), .d1-rating-name, .rd-numbers, .rd-label, .rd-note'});
        const fonts = []; for(const nodeId of nodeIds) fonts.push(...(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts);
        if (variant !== 'before' && fonts.some(f => f.glyphCount > 0 && f.familyName.replaceAll(' ', '-') !== font)) throw new Error('Unexpected font: ' + JSON.stringify(fonts));
        const filename = `${variant}-${font}-${scenario}-${width}.png`;
        const png = await c.page.screenshot({ path: join(output, filename), type:'png' });
        await c.page.keyboard.press('Escape');
        await c.frame();
        const escapeStaysClosed = !(await dialog.count());
        records.push({ scenario, requestedFont: font, escapeStaysClosed, baseCommit:"c50ea3c6b640633b2e590b32785c162bcd805efd", sourceDigests:variant === "before" ? null : sourceDigests, buildManifestDigest, filename, sha256:digest(png), viewport:{width,height:width===1280?900:844}, fixture:fixtureName, fixtureSha256:digest(bytes), webgl:c.info, fonts, measured, errors:c.errors });
        console.log(filename, JSON.stringify({ card:measured.card, issues:measured.labels.filter(l=>l.lines>1||l.clipped),overlaps:measured.overlaps,alignments:measured.alignments,smallType:measured.labels.filter(l=>l.fontSize<13),errors:c.errors, missing }));
      } finally { await c.close(); }
    }
  }
} finally { await browser.close(); writeFileSync(join(output,`${variant}-${font}.json`),JSON.stringify(records,null,2)); }

if(variant !== "before" && records.some((r:any) => !r.escapeStaysClosed || r.errors.length || !r.measured.withinViewport || r.measured.card.scroll || r.measured.overlaps.length || r.measured.alignments.some((a:any)=>a.maxDifference>1) || r.measured.labels.some((l:any)=>l.lines>1||l.clipped||l.fontSize<13))) throw new Error("Render acceptance failed; inspect capture records");
