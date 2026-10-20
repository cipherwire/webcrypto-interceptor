#!/usr/bin/env node
'use strict';

// Standalone Runtime String Table Unpacker.
// Drives the obfuscator's live string decoder routine in an isolated
// headless browser context, dumping decrypted string dictionaries to JSON.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { resolveBrowserPath } = require('../src/util/browser');
const { unpackStrings } = require('../src/cdp/strings');

const HELP = `
Usage:
  node scripts/unpack-strings.js <URL> <decoderExpr> [options]

Arguments:
  <URL>             Target website URL
  <decoderExpr>     Name or expression of the runtime decoder (e.g. "_0x1a2b" or "window.getStr")

Options:
  --start <num>     Starting index (default: 0)
  --count <num>     Number of indices to probe (default: 512)
  --out <path>      Output JSON file path (default: ./strings_<ts>.json)
  --brave           Use Brave browser
  --help            Show this help message

Example:
  node scripts/unpack-strings.js "https://target.local" "_0x5a1b" --count 256
`.trim();

async function main() {
    let parsed;
    try {
        parsed = parseArgs({
            args: process.argv.slice(2),
            options: {
                start: { type: 'string', default: '0' },
                count: { type: 'string', default: '512' },
                out: { type: 'string' },
                brave: { type: 'boolean', default: false },
                help: { type: 'boolean', default: false }
            },
            allowPositionals: true
        });
    } catch (e) {
        console.error(e.message + '\n\n' + HELP);
        process.exit(2);
    }

    if (parsed.values.help) {
        console.log(HELP);
        process.exit(0);
    }

    const [url, decoderExpr] = parsed.positionals;
    if (!url || !decoderExpr) {
        console.error('Missing required <URL> or <decoderExpr> arguments.\n\n' + HELP);
        process.exit(2);
    }

    let puppeteer;
    try {
        puppeteer = require('puppeteer');
    } catch {
        console.error('puppeteer is required. Run: npm install');
        process.exit(1);
    }

    const browserPath = resolveBrowserPath(parsed.values.brave);
    const start = parseInt(parsed.values.start, 10) || 0;
    const count = parseInt(parsed.values.count, 10) || 512;

    console.log(`[+] Launching Chromium for string extraction...`);
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: browserPath || undefined,
        pipe: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        console.log(`[+] Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

        const cdp = await page.target().createCDPSession();
        console.log(`[+] Probing decoder ${decoderExpr} (indices ${start}..${start + count - 1})...`);

        const res = await unpackStrings(cdp, decoderExpr, { start, count });
        console.log(`[+] Extracted ${res.count} strings across ${res.probed} probed indices.`);

        const outFile = parsed.values.out || path.join(process.cwd(), `strings_${Date.now()}.json`);
        fs.writeFileSync(outFile, JSON.stringify(res.decoded, null, 2), 'utf8');
        console.log(`[+] Saved dictionary to ${outFile}`);
    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('Error during string extraction:', err.message || err);
    process.exit(1);
});
