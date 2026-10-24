const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { SUBTLE_METHODS, CRYPTO_BP_RATE_LIMIT } = require('../config');

// Serializes crypto.subtle call arguments the same way the page-side wrapper
// does: ArrayBuffers/typed arrays to hex, CryptoKey to a metadata object.
// Plain JSON.stringify would collapse both to {} - exactly the payloads that
// matter here. Evaluated on the paused wrapper frame via evaluateOnCallFrame;
// the outer `arguments` resolves in that frame's scope.
const ARGS_EXPR = `(function (args) {
    function bytes(u, name) {
        var hex = '';
        var limit = Math.min(u.length, 512);
        for (var i = 0; i < limit; i++) hex += (u[i] < 16 ? '0' : '') + u[i].toString(16);
        var out = { __t: name || 'Bytes', len: u.length, hex: hex };
        try {
            var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u.subarray(0, 512));
            if (utf8 && utf8.indexOf('\\uFFFD') === -1) {
                var printable = 0;
                for (var j = 0; j < utf8.length; j++) {
                    var c = utf8.charCodeAt(j);
                    if ((c >= 0x20 && c <= 0x7E) || c === 9 || c === 10 || c === 13 || c > 0x7F) printable++;
                }
                if (utf8.length > 0 && printable / utf8.length >= 0.9) out.utf8 = utf8;
            }
        } catch (e) {}
        return out;
    }
    function ser(v, d) {
        if (v === null || v === undefined) return v;
        var t = typeof v;
        if (t === 'string') return v.length > 512 ? v.substring(0, 512) + '...' : v;
        if (t === 'number' || t === 'boolean') return v;
        if (t === 'function') return '[function]';
        if (v instanceof ArrayBuffer) return bytes(new Uint8Array(v), 'ArrayBuffer');
        if (ArrayBuffer.isView && ArrayBuffer.isView(v)) return bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), v.constructor && v.constructor.name);
        if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) return { __t: 'CryptoKey', type: v.type, extractable: v.extractable, algorithm: v.algorithm, usages: v.usages };
        if (Array.isArray(v)) { if (d <= 0) return '[Array len=' + v.length + ']'; return v.slice(0, 16).map(function (x) { return ser(x, d - 1); }); }
        if (t === 'object') {
            if (d <= 0) return '[Object]';
            var out = {};
            var keys;
            try { keys = Object.keys(v).slice(0, 24); } catch (e) { return '[unreadable]'; }
            for (var i = 0; i < keys.length; i++) {
                try { out[keys[i]] = ser(v[keys[i]], d - 1); } catch (e) { out[keys[i]] = '[unreadable]'; }
            }
            return out;
        }
        return String(v);
    }
    try { return JSON.stringify(args.map(function (a) { return ser(a, 3); })); } catch (e) { return '[unserializable]'; }
})(Array.prototype.slice.call(arguments))`;

async function recordCryptoCall(cdpSession, params, bpMap, targetLabel) {
    const frames = params.callFrames || [];
    if (!frames.length) return;

    const hitBps = params.hitBreakpoints || [];
    const method = hitBps.map(b => bpMap[b]).find(m => m) || 'crypto.subtle.*';

    // Proof-of-work flood guard: digest() loops can hit hundreds of times per
    // second; record the first N, summarize the rest, never stall the page.
    if (!allowCryptoHit(cdpSession, method)) return;

    // The top frame is our page-side wrapper in stealth.js (functionName equals
    // one of the SUBTLE_METHODS). Skip it so the reported caller is the site's
    // real call site. Only skip ONE wrapper level - a site function that is
    // itself legitimately named "encrypt"/"decrypt" must not be skipped too.
    const wrapperNames = new Set(SUBTLE_METHODS);
    let skip = 0;
    if (skip < frames.length && wrapperNames.has(frames[skip].functionName)) skip++;
    const displayFrames = frames.slice(skip);
    if (!displayFrames.length) return;

    const caller = displayFrames[0];
    const callerName = caller.functionName || '<anonymous>';

    // Arguments: only meaningful when the wrapper frame is present (its
    // `arguments` are exactly what the site passed to crypto.subtle.<method>).
    // Without the wrapper, frames[0] is the site caller and its `arguments`
    // would be the CALLER's own parameters - wrong data, so capture nothing.
    let args;
    if (skip === 1) {
        try {
            const r = await cdpSession.send('Debugger.evaluateOnCallFrame', {
                callFrameId: frames[0].callFrameId,
                expression: ARGS_EXPR,
                returnByValue: true,
                silent: true
            });
            if (r.result && typeof r.result.value === 'string' && r.result.value !== '[unserializable]') {
                try { args = JSON.parse(r.result.value); } catch (e) { args = r.result.value; }
            }
        } catch (e) { /* frame not evaluable - record stays args-less */ }
    }

    const stackTrace = displayFrames.map(f => {
        const file = f.url ? shortUrl(f.url) : '<anonymous>';
        return `   at ${f.functionName || '<anonymous>'} (${file}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1})`;
    }).slice(0, 5).join('\n');

    let asyncTrace = '';
    const asyncStack = [];
    let curAsync = params.asyncStackTrace;
    while (curAsync && curAsync.callFrames && asyncStack.length < 5) {
        const desc = curAsync.description || 'async';
        for (const f of curAsync.callFrames) {
            const file = f.url ? shortUrl(f.url) : '<anonymous>';
            asyncTrace += `\n   [${desc}] at ${f.functionName || '<anonymous>'} (${file}:${(f.lineNumber || 0) + 1}:${(f.columnNumber || 0) + 1})`;
            asyncStack.push({ fn: f.functionName, url: f.url, line: f.lineNumber, col: f.columnNumber, async: desc });
            if (asyncStack.length >= 5) break;
        }
        curAsync = curAsync.parent;
    }

    console.log(`\n${C.hlred}[🔓 CRYPTO BOUNDARY] ${method}${C.reset} in ${C.magenta}${targetLabel}${C.reset} called by ${C.yellow}${callerName}${C.reset}`);
    console.log(`${C.dim}${stackTrace}${asyncTrace}${C.reset}`);
    if (args) console.log(`${C.dim}   args ${JSON.stringify(args).substring(0, 240)}${C.reset}`);

    writeLog({
        type: 'crypto_call',
        method,
        target: targetLabel,
        caller: callerName,
        args,
        stack: displayFrames.map(f => ({ fn: f.functionName, url: f.url, line: f.location.lineNumber, col: f.location.columnNumber })),
        asyncStack: asyncStack.length ? asyncStack : undefined
    });
}

// Per-session, per-method rolling-window rate limiter for CDP breakpoint hits.
const bpRateWindows = new WeakMap(); // session -> Map(method -> { windowStart, count, suppressed })

function allowCryptoHit(cdpSession, method) {
    let m = bpRateWindows.get(cdpSession);
    if (!m) { m = new Map(); bpRateWindows.set(cdpSession, m); }
    const now = Date.now();
    let w = m.get(method);
    if (!w || now - w.windowStart > 1000) {
        if (w && w.suppressed > 0) {
            console.log(`${C.yellow}[🔓 CRYPTO]${C.reset} rate-limited ${w.suppressed} further ${method} hit(s) in the last second`);
            writeLog({ type: 'crypto_rate_limited', method, suppressed: w.suppressed });
        }
        w = { windowStart: now, count: 0, suppressed: 0 };
        m.set(method, w);
    }
    w.count++;
    if (w.count > CRYPTO_BP_RATE_LIMIT) {
        w.suppressed++;
        return false;
    }
    return true;
}

// Per-context armament bookkeeping. Contexts are created and destroyed
// constantly (navigations, iframes); arming 12 breakpoints per context without
// ever removing them leaks both Debugger.breakpoint entries and RemoteObject
// handles until long sessions grind to a halt. We now track what was armed
// for each context and tear it down on executionContextDestroyed.
//
// Keyed WeakMap(session) -> Map(contextId -> record): executionContextIds are
// only unique WITHIN one CDP session, so a module-level Map(contextId) made
// two concurrently attached targets with the same context id collide - the
// second target's context was skipped as "already armed" and captured nothing.
const sessionArmed = new WeakMap();

function armedFor(cdpSession) {
    let m = sessionArmed.get(cdpSession);
    if (!m) { m = new Map(); sessionArmed.set(cdpSession, m); }
    return m;
}

async function armCryptoBreakpoints(cdpSession, targetLabel, bpMap, contextId) {
    const perSession = armedFor(cdpSession);
    if (perSession.has(contextId)) return 0; // already armed for this context
    const record = { breakpointIds: [], objectIds: [] };

    // Target SubtleCrypto.prototype.<method> (native) rather than
    // crypto.subtle.<method>, which by page-load time is shadowed by our
    // stealth.js wrapper. Prototype gives us the real native fn so each of
    // the 12 methods gets a distinct breakpoint id.
    //
    // Arm all 12 in parallel: sequentially this cost 2 round-trips per method,
    // and load-time crypto calls regularly ran before the last breakpoints
    // landed. Promise.all brings arming down to ~2 round-trips total.
    const results = await Promise.all(SUBTLE_METHODS.map(async (method) => {
        try {
            const fn = await cdpSession.send('Runtime.evaluate', {
                expression: `SubtleCrypto.prototype.${method}`,
                contextId: contextId,
                silent: true
            });
            if (fn.result && fn.result.type === 'function' && fn.result.objectId) {
                const bp = await cdpSession.send('Debugger.setBreakpointOnFunctionCall', {
                    objectId: fn.result.objectId
                });
                return { objectId: fn.result.objectId, breakpointId: bp.breakpointId, method };
            }
        } catch (e) { /* method unavailable in this context */ }
        return null;
    }));

    let armed = 0;
    for (const r of results) {
        if (!r) continue;
        record.objectIds.push(r.objectId);
        if (r.breakpointId) {
            bpMap[r.breakpointId] = `crypto.subtle.${r.method}`;
            record.breakpointIds.push(r.breakpointId);
            armed++;
        }
    }
    if (armed > 0) {
        perSession.set(contextId, record);
        console.log(`${C.magenta}[🕷️  CRYPTO HOOK]${C.reset} ${armed} breakpoints armed on ${C.cyan}${targetLabel}${C.reset} (context ${contextId})`);
    }
    return armed;
}

// Tear down everything armed for contexts that just died. Returns the number
// of breakpoints removed so the caller can log if verbose.
async function cleanupContexts(cdpSession, destroyedContextIds, bpMap) {
    const perSession = armedFor(cdpSession);
    for (const contextId of destroyedContextIds) {
        const record = perSession.get(contextId);
        if (!record) continue;
        for (const bpId of record.breakpointIds) {
            try { await cdpSession.send('Debugger.removeBreakpoint', { breakpointId: bpId }); } catch (e) {}
            delete bpMap[bpId];
        }
        for (const objectId of record.objectIds) {
            try { await cdpSession.send('Runtime.releaseObject', { objectId }); } catch (e) {}
        }
        perSession.delete(contextId);
    }
}

module.exports = { recordCryptoCall, armCryptoBreakpoints, cleanupContexts };
