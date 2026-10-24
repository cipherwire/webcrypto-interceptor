'use strict';

// E2E: a hook target that does not exist at execution-context creation (page
// script defines it shortly after load) must be armed by the re-arm loop and
// capture calls. Regression for the live-verified arming race where --hook on
// page-defined functions frequently never armed at all.

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

test('E2E: hook defined after context creation is rearmed and captures calls', { skip: skipReason }, async () => {
    const puppeteer = require('puppeteer');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-e2e-hook-'));
    log.setLogDir(tmpDir);

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>wci hook e2e</h1></body></html>');
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

        const mainClient = await page.target().createCDPSession();
        await attachToSession(mainClient, 'main:e2e-hook', {
            getExtractDir: () => null,
            hooks: [{ expr: 'window.lateFn', captureReturn: false, traceFlow: false }],
            // speed up the retry loop for the test
            rearmIntervalMs: 250,
            rearmMaxAttempts: 12
        });

        await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

        // Define the target function 400ms after load (long after the context
        // and the first arm pass are gone), then call it repeatedly so at least
        // one call lands after the re-arm loop picks it up.
        await page.evaluate(() => {
            setTimeout(() => {
                window.lateFn = function lateFn(a) { return 'late:' + a; };
            }, 400);
            let i = 0;
            const t = setInterval(() => {
                if (typeof window.lateFn === 'function') window.lateFn('call-' + (++i));
            }, 400);
            setTimeout(() => clearInterval(t), 8000);
        });

        await new Promise(r => setTimeout(r, 6000));

        const logPath = log.getLogFile();
        assert.ok(fs.existsSync(logPath), 'session log file must exist');
        const events = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

        const hookCalls = events.filter(e => e.type === 'hook_call' && e.hook === 'window.lateFn');
        assert.ok(hookCalls.length >= 1, 'at least one late-defined hook call must be captured');
        assert.ok(
            hookCalls.some(h => JSON.stringify(h.args).includes('call-')),
            'captured args must come from the page-defined function');
    } finally {
        log.closeLog();
        log.resetLogStateForTesting();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        await browser.close();
        server.close();
    }
});
