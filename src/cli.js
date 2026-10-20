// CLI parsing for capture_server.js - extracted so it can be unit-tested
// without launching puppeteer.
const { parseArgs } = require('node:util');

const HELP = `
webcrypto-interceptor - stealth CDP-based reverse-engineering toolkit

Usage:
  node capture_server.js <URL> [options]

Options:
  --gui                  Show the browser window (recommended: you can click around)
  --brave                Use Brave browser instead of Chrome / Chromium
  --full                 Extract every script/response body to disk (site dump)
  --out <dir>            Base directory for the extract folder and session log (default: cwd)
  --timeout <seconds>    Page navigation timeout (default: 60)
  --ua <user-agent>      Override the browser User-Agent on every attached target
  --proxy <server>       Launch Chrome through a proxy, e.g. --proxy "http://127.0.0.1:8080"
  --all-traffic          Disable the analytics/tracker noise filter (capture everything)
  --hook <expr>          Invisible breakpoint hook on a site function (repeatable).
                         Logs every call with arguments + stack. The function is
                         never wrapped - fn.toString() checks see nothing.
                         Example: --hook "window.signRequest"
  --hook-return <expr>   Like --hook, but also arms breakpoints on the function's
                         return locations and records (input -> output) pairs.
                         Pairs feed scripts/verify-reimpl.js. Example:
                         --hook-return "window.buildPayload"
  --trace-flow <expr>    Like --hook-return, but also follows forward dataflow:
                         identifies the consumer caller and variable receiving
                         the returned ciphertext or token. (repeatable)
  --dump-strings <expr>  Drive the page's runtime string decoder function across
                         index ranges to dump rotated string tables. Example:
                         --dump-strings "_0x1a2b"
  --trace-vm <loc>       Trace a bytecode VM dispatch loop at script location
                         <urlRegex:line[:column]>. (repeatable)
  --watch <exprs>        Comma-separated expressions to evaluate on VM loop hit
                         (e.g. --watch "pc,opcode,stack[sp]")
  --heap-diff <seconds>  Snapshot the heap after load, wait <seconds>, snapshot
                         again, and report what the page activity allocated:
                         new user-retained strings (secret-classified), typed
                         arrays, object counts. Catches decoded secrets that
                         never touch the network or crypto.subtle.
  --help                 Show this help

Environment:
  PUPPETEER_EXECUTABLE_PATH   Path to a Chrome/Chromium binary (overrides auto-detection)

Examples:
  node capture_server.js "https://example.com" --gui
  node capture_server.js "https://example.com" --brave --gui
  node capture_server.js "https://example.com" --full --out ./dumps --timeout 90
  node capture_server.js "https://example.com" --hook "window.sign" --hook-return "window.buildPayload"
  node capture_server.js "https://example.com" --trace-flow "window.signPayload"
  node capture_server.js "https://example.com" --dump-strings "_0x1a2b"
  node capture_server.js "https://example.com" --heap-diff 30
  npx webcrypto-interceptor "https://example.com" --gui
`.trim();

function usageError(message) {
    const err = new Error(message + '\n\n' + HELP);
    err.isUsageError = true;
    return err;
}

function parseArgv(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                gui: { type: 'boolean', default: false },
                brave: { type: 'boolean', default: false },
                full: { type: 'boolean', default: false },
                out: { type: 'string' },
                timeout: { type: 'string', default: '60' },
                ua: { type: 'string' },
                proxy: { type: 'string' },
                'all-traffic': { type: 'boolean', default: false },
                hook: { type: 'string', multiple: true },
                'hook-return': { type: 'string', multiple: true },
                'trace-flow': { type: 'string', multiple: true },
                'dump-strings': { type: 'string' },
                'trace-vm': { type: 'string', multiple: true },
                watch: { type: 'string' },
                'heap-diff': { type: 'string' },
                help: { type: 'boolean', default: false }
            },
            allowPositionals: true
        });
    } catch (e) {
        throw usageError(e.message);
    }

    if (parsed.values.help) {
        return { help: true };
    }

    const positional = parsed.positionals.filter(a => a && !a.startsWith('-'));
    const url = positional[0];
    if (!url) throw usageError('Missing <URL> argument.');
    if (!/^https?:\/\//i.test(url)) {
        throw usageError(`URL must start with http:// or https:// (got "${url}").`);
    }

    let timeout = parseInt(parsed.values.timeout, 10);
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw usageError(`--timeout must be a positive number of seconds (got "${parsed.values.timeout}").`);
    }

    const hooks = parsed.values.hook || [];
    const hookReturns = parsed.values['hook-return'] || [];
    const traceFlows = parsed.values['trace-flow'] || [];
    for (const h of [...hooks, ...hookReturns, ...traceFlows]) {
        if (!h || !h.trim()) throw usageError('--hook / --hook-return / --trace-flow expressions must not be empty.');
    }

    const traceVM = parsed.values['trace-vm'] || [];
    for (const tvm of traceVM) {
        if (!tvm || !tvm.trim()) throw usageError('--trace-vm location must not be empty.');
    }

    const watchExprs = parsed.values.watch
        ? parsed.values.watch.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    let heapDiff = 0;
    if (parsed.values['heap-diff'] !== undefined) {
        heapDiff = parseInt(parsed.values['heap-diff'], 10);
        if (!Number.isFinite(heapDiff) || heapDiff < 0) {
            throw usageError(`--heap-diff must be a non-negative number of seconds (got "${parsed.values['heap-diff']}").`);
        }
    }

    return {
        help: false,
        url,
        gui: parsed.values.gui,
        brave: parsed.values.brave,
        full: parsed.values.full,
        out: parsed.values.out || process.cwd(),
        timeout: timeout * 1000,
        ua: parsed.values.ua || null,
        proxy: parsed.values.proxy || null,
        allTraffic: parsed.values['all-traffic'],
        hooks: hooks.map(expr => ({ expr: expr.trim(), captureReturn: false, traceFlow: false })),
        hookReturns: hookReturns.map(expr => ({ expr: expr.trim(), captureReturn: true, traceFlow: false })),
        traceFlows: traceFlows.map(expr => ({ expr: expr.trim(), captureReturn: true, traceFlow: true })),
        dumpStrings: parsed.values['dump-strings'] ? parsed.values['dump-strings'].trim() : null,
        traceVM: traceVM.map(locStr => ({ locStr: locStr.trim(), watch: watchExprs })),
        heapDiff
    };
}

module.exports = { parseArgv, HELP };
