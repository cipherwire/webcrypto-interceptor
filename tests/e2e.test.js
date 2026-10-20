'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { resolveBrowserPath } = require('../src/util/browser');

const browserPath = resolveBrowserPath(false) || resolveBrowserPath(true);
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const skipReason = process.env.SKIP_E2E
    ? 'E2E tests disabled by SKIP_E2E environment variable'
    : (!browserPath && !isCI ? 'No compatible browser (Chrome/Brave) found on host' : false);

test('End-to-end: live browser WebCrypto interception', { skip: skipReason }, async () => {
    if (!browserPath) {
        assert.fail('E2E browser integration test failed: CI environment requires an available Chrome or Brave browser, but none was detected on the host.');
    }
    const puppeteer = require('puppeteer');
    const { attachToSession } = require('../src/cdp/session');

    // Spin up local HTTP server to guarantee a Secure Context
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>WCI E2E Test</h1></body></html>');
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

        // Inject stealth.js
        const hookSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'stealth.js'), 'utf8');
        const hookCode = `(typeof globalThis !== 'undefined' ? globalThis : self).__WCI_CFG = { allTraffic: true };\n` + hookSource;
        await page.evaluateOnNewDocument(hookCode);

        const mainClient = await page.target().createCDPSession();
        await attachToSession(mainClient, 'main:e2e-test', {
            getExtractDir: () => null,
            hooks: []
        });

        await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

        // Execute WebCrypto operation in browser page
        /* global window */
        const evalResult = await page.evaluate(async () => {
            const key = await window.crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );

            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const plaintext = new window.TextEncoder().encode('E2E WebCrypto Interception Verified');

            const ciphertext = await window.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                plaintext
            );

            return {
                ciphertextLen: ciphertext.byteLength,
                hasBinding: typeof window.__wci === 'function',
                isSecureContext: window.isSecureContext
            };
        });

        assert.equal(evalResult.hasBinding, true, '__wci binding must be available');
        assert.equal(evalResult.isSecureContext, true, 'Window must be a secure context');
        assert.ok(evalResult.ciphertextLen > 0, 'Ciphertext must be generated');

        // Allow microtask cycle for event dispatch
        await new Promise(r => setTimeout(r, 500));
    } finally {
        await browser.close();
        server.close();
    }
});
