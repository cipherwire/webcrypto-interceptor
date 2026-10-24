'use strict';

// E2E: a dedicated (blob:) worker that encrypts a unique plaintext must be
// captured on the STRUCTURED binding channel. Regression for two live-verified
// bugs: puppeteer reports dedicated workers as target type 'other' (the old
// type check never took the worker branch, so stealth.js was never injected),
// and the old order injected hook code before Runtime.addBinding existed, so
// worker events were stuck on the console channel.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveBrowserPath } = require('../src/util/browser');
const log = require('../src/util/log');
const { attachToSession, ensureBinding } = require('../src/cdp/session');

const browserPath = resolveBrowserPath(false) || resolveBrowserPath(true);
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const skipReason = process.env.SKIP_E2E
    ? 'E2E tests disabled by SKIP_E2E environment variable'
    : (!browserPath && !isCI ? 'No compatible browser (Chrome/Brave) found on host' : false);

const WORKER_PLAINTEXT = 'worker-e2e-secret-42';

test('E2E: dedicated worker crypto is captured on the binding channel', { skip: skipReason }, async () => {
    const puppeteer = require('puppeteer');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-e2e-worker-'));
    log.setLogDir(tmpDir);

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>wci worker e2e</h1></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const testUrl = `http://127.0.0.1:${server.address().port}/`;

    const browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: 'new',
        pipe: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        const hookSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'stealth.js'), 'utf8');
        const hookCode = `(typeof globalThis !== 'undefined' ? globalThis : self).__WCI_CFG = { allTraffic: true };\n` + hookSource;

        const mainClient = await page.target().createCDPSession();
        await attachToSession(mainClient, 'main:e2e-worker', { getExtractDir: () => null, hooks: [] });

        // Same attach flow as capture_server.js tryAttachTarget: probe the
        // scope, install the binding BEFORE injecting hook code.
        browser.on('targetcreated', async (t) => {
            try {
                const type = t.type();
                if (type !== 'other') return;
                const child = await t.createCDPSession();
                const probe = await child.send('Runtime.evaluate', {
                    expression: 'typeof document === "undefined" && typeof WorkerGlobalScope !== "undefined"',
                    returnByValue: true,
                    silent: true
                });
                if (!(probe.result && probe.result.value)) return;
                await child.send('Runtime.enable');
                await ensureBinding(child);
                await child.send('Runtime.evaluate', { expression: hookCode, silent: true });
                await attachToSession(child, 'other:blob-worker', { getExtractDir: () => null, hooks: [] });
            } catch (e) { /* attach races are fine */ }
        });

        await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

        // Worker created AFTER attach; crypto triggered via postMessage well
        // after injection has had time to complete.
        const workerSrc = `onmessage = async (e) => {
            const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(${JSON.stringify(WORKER_PLAINTEXT)}));
            postMessage(ct.byteLength);
        };`;
        await page.evaluate((src) => {
            window.__w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
            window.__w.onmessage = () => {};
            setTimeout(() => window.__w.postMessage('go'), 800);
        }, workerSrc);

        await new Promise(r => setTimeout(r, 2500));

        const logPath = log.getLogFile();
        assert.ok(fs.existsSync(logPath), 'session log file must exist');
        const events = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

        const workerCrypto = events.filter(e =>
            e.type === 'hook_event' && e.channel === 'binding' &&
            typeof e.message === 'string' && e.message.includes(WORKER_PLAINTEXT));
        assert.ok(workerCrypto.length >= 1,
            'worker encrypt call with the unique plaintext must arrive on the binding channel');
    } finally {
        log.closeLog();
        log.resetLogStateForTesting();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        await browser.close();
        server.close();
    }
});
