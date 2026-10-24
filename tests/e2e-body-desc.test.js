'use strict';

// E2E: body/payload description. Regression for live-verified losses:
//   - fetch body sent as URLSearchParams rendered as "[object Object]"
//   - binary WebSocket frames (binaryType 'blob') rendered as "[object Object]"
//   - Blob posted to a worker rendered as "{}"

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveBrowserPath } = require('../src/util/browser');
const log = require('../src/util/log');
const { attachToSession } = require('../src/cdp/session');

const browserPath = resolveBrowserPath(false) || resolveBrowserPath(true);
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const skipReason = process.env.SKIP_E2E
    ? 'E2E tests disabled by SKIP_E2E environment variable'
    : (!browserPath && !isCI ? 'No compatible browser (Chrome/Brave) found on host' : false);

test('E2E: URLSearchParams, binary WS frames and Blob postMessage are described', { skip: skipReason }, async () => {
    const puppeteer = require('puppeteer');
    // 'ws' arrives with puppeteer's dependency tree; used for the echo server.
    const WebSocketServer = require('ws').WebSocketServer;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-e2e-body-'));
    log.setLogDir(tmpDir);

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (sock) => {
        sock.on('message', (data, isBinary) => sock.send(data, { binary: isBinary }));
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const testUrl = `http://127.0.0.1:${port}/`;

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
        await page.evaluateOnNewDocument(hookCode);

        const mainClient = await page.target().createCDPSession();
        await attachToSession(mainClient, 'main:e2e-body', { getExtractDir: () => null, hooks: [] });

        await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

        await page.evaluate((wsPort) => {
            // 1. URLSearchParams fetch body
            fetch('/api/search', { method: 'POST', body: new URLSearchParams({ q: 'e2e-body', token: 'tok-123' }) });
            // 2. binary WebSocket frame (echoed back as a Blob by the server)
            const ws = new WebSocket('ws://127.0.0.1:' + wsPort);
            ws.onopen = () => ws.send(new Uint8Array([1, 2, 3, 4, 5]).buffer);
            // 3. Blob posted to a worker (page-side Worker.prototype.postMessage hook)
            const w = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>{};'], { type: 'application/javascript' })));
            w.postMessage(new Blob(['x'.repeat(20)], { type: 'application/json' }));
        }, port);

        await new Promise(r => setTimeout(r, 1500));

        const logPath = log.getLogFile();
        assert.ok(fs.existsSync(logPath), 'session log file must exist');
        const messages = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean)
            .filter(e => e.type === 'hook_event' && typeof e.message === 'string')
            .map(e => e.message);
        const all = messages.join('\n');

        assert.ok(all.includes('q=e2e-body&token=tok-123'), 'URLSearchParams body must be captured as its query string');
        assert.ok(all.includes('[binary ws 5B]'), 'binary WS frames must be described with their byte size');
        assert.ok(all.includes('[blob 20B application/json]'), 'Blob postMessage payloads must be described with size and type');
        assert.ok(!all.includes('[object Object]'), 'no payload may degrade to [object Object]');
    } finally {
        log.closeLog();
        log.resetLogStateForTesting();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        await browser.close();
        server.close();
    }
});
