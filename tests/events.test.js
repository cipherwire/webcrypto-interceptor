const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const events = require('../src/cdp/events');
const log = require('../src/util/log');

// Route test logs into a temp dir so we never pollute cwd.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-events-'));
log.setLogDir(tmpDir);

test('stealth.js compiles (syntax guard for browser-injected code)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'stealth.js'), 'utf8');
    assert.doesNotThrow(() => new Function(src));
    assert.ok(src.includes('globalThis'), 'must be scope-agnostic (worker support)');
    assert.ok(!src.includes('__WCI_PART'), 'no leftover chunk markers');
});

test('stealth.js WebAssembly hooks handle TypedArray view boundaries correctly and restore cleanly', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'stealth.js'), 'utf8');
    const emitted = [];
    const prevWci = globalThis.__wci;
    const origWasm = {
        compile: WebAssembly.compile,
        instantiate: WebAssembly.instantiate,
        compileStreaming: WebAssembly.compileStreaming,
        instantiateStreaming: WebAssembly.instantiateStreaming
    };
    globalThis.__wci = (raw) => {
        try { emitted.push(JSON.parse(raw)); } catch {}
    };

    try {
        new Function(src)();

        // TypedArray view with non-zero byteOffset
        const backingBuffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        const view = new Uint8Array(backingBuffer.buffer, 8, 8); // offset 8, len 8 (0061736d01000000)

        WebAssembly.compile(view);
        const wasmEvt = emitted.find(e => e.type === 'wasm' && e.data && e.data.method === 'compile');
        assert.ok(wasmEvt, 'wasm compile event emitted');
        assert.equal(wasmEvt.data.bytes, 8, 'Must capture exact view length (8 bytes), not backing buffer length (16)');

        const hexChunk = emitted.find(e => e.type === 'wasm_hex');
        assert.ok(hexChunk, 'wasm_hex chunk emitted');
        assert.equal(hexChunk.hex, '0061736d01000000', 'Hex must match view bytes starting at byteOffset');
        assert.ok(hexChunk.transferId, 'transferId must be populated in chunk envelope');
    } finally {
        if (prevWci !== undefined) globalThis.__wci = prevWci;
        else delete globalThis.__wci;
        WebAssembly.compile = origWasm.compile;
        WebAssembly.instantiate = origWasm.instantiate;
        WebAssembly.compileStreaming = origWasm.compileStreaming;
        WebAssembly.instantiateStreaming = origWasm.instantiateStreaming;
    }
    assert.equal(WebAssembly.compile, origWasm.compile, 'WebAssembly globals must be restored cleanly');
});

test('stealth.js streaming capture ignores non-ok responses and non-wasm content-types', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'stealth.js'), 'utf8');
    const emitted = [];
    const prevWci = globalThis.__wci;
    const origWasm = {
        compile: WebAssembly.compile,
        instantiate: WebAssembly.instantiate,
        compileStreaming: WebAssembly.compileStreaming,
        instantiateStreaming: WebAssembly.instantiateStreaming
    };
    globalThis.__wci = (raw) => {
        try { emitted.push(JSON.parse(raw)); } catch {}
    };

    try {
        new Function(src)();

        // 1. Non-ok response (404 Not Found)
        const mock404 = {
            ok: false,
            status: 404,
            headers: new Map([['content-type', 'application/wasm']]),
            clone() { return this; }
        };
        try { await WebAssembly.compileStreaming(Promise.resolve(mock404)); } catch {}

        // 2. Non-WASM content type (HTML error page)
        const mockHtml = {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'text/html; charset=utf-8']]),
            clone() { return this; }
        };
        try { await WebAssembly.compileStreaming(Promise.resolve(mockHtml)); } catch {}

        // Wait microtasks for promises to settle
        await new Promise(r => setTimeout(r, 10));

        assert.equal(emitted.filter(e => e.type === 'wasm').length, 0, 'Must not dump 404 or text/html as WASM');
    } finally {
        if (prevWci !== undefined) globalThis.__wci = prevWci;
        else delete globalThis.__wci;
        WebAssembly.compile = origWasm.compile;
        WebAssembly.instantiate = origWasm.instantiate;
        WebAssembly.compileStreaming = origWasm.compileStreaming;
        WebAssembly.instantiateStreaming = origWasm.instantiateStreaming;
    }
});

test('stealth.js streaming capture reads chunks and enforces 5MB limit', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'stealth.js'), 'utf8');
    const emitted = [];
    const prevWci = globalThis.__wci;
    const origWasm = {
        compile: WebAssembly.compile,
        instantiate: WebAssembly.instantiate,
        compileStreaming: WebAssembly.compileStreaming,
        instantiateStreaming: WebAssembly.instantiateStreaming
    };
    globalThis.__wci = (raw) => {
        try { emitted.push(JSON.parse(raw)); } catch {}
    };

    try {
        new Function(src)();

        // 1. Valid small stream using ReadableStream reader
        const wasmHeader = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        let readIdx = 0;
        const validReader = {
            read() {
                if (readIdx === 0) {
                    readIdx++;
                    return Promise.resolve({ done: false, value: wasmHeader });
                }
                return Promise.resolve({ done: true });
            }
        };
        const mockValid = {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/wasm']]),
            clone() {
                return { body: { getReader() { return validReader; } } };
            }
        };

        try { await WebAssembly.compileStreaming(Promise.resolve(mockValid)); } catch {}
        await new Promise(r => setTimeout(r, 20));

        const dumped = emitted.find(e => e.type === 'wasm_hex');
        assert.ok(dumped, 'Streaming chunks must be captured and dumped');
        assert.equal(dumped.hex, '0061736d01000000');

        // 2. Oversized stream: chunks exceed 5MB -> reader cancelled and not dumped
        let cancelled = false;
        const largeChunk = new Uint8Array(3 * 1024 * 1024); // 3MB chunk
        let largeReads = 0;
        const oversizeReader = {
            read() {
                largeReads++;
                if (largeReads <= 2) {
                    return Promise.resolve({ done: false, value: largeChunk });
                }
                return Promise.resolve({ done: true });
            },
            cancel() {
                cancelled = true;
            }
        };
        const mockOversize = {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/wasm']]),
            clone() {
                return { body: { getReader() { return oversizeReader; } } };
            }
        };

        emitted.length = 0;
        try { await WebAssembly.compileStreaming(Promise.resolve(mockOversize)); } catch {}
        await new Promise(r => setTimeout(r, 20));

        assert.equal(cancelled, true, 'Reader must be cancelled once 5MB threshold is exceeded');
        assert.equal(emitted.filter(e => e.type === 'wasm_hex').length, 0, 'Oversized wasm must not be dumped');
    } finally {
        if (prevWci !== undefined) globalThis.__wci = prevWci;
        else delete globalThis.__wci;
        WebAssembly.compile = origWasm.compile;
        WebAssembly.instantiate = origWasm.instantiate;
        WebAssembly.compileStreaming = origWasm.compileStreaming;
        WebAssembly.instantiateStreaming = origWasm.instantiateStreaming;
    }
});

test('isDuplicate tracks uids', () => {
    assert.equal(events.isDuplicate('u1'), false);
    assert.equal(events.isDuplicate('u1'), true);
    assert.equal(events.isDuplicate(null), false);
});

test('reassembleChunks reassembles ordered hex chunks including real transport uid#seq envelopes', () => {
    // 1. Shared uid envelope (legacy/synthetic)
    const same = [
        { uid: 'c1', type: 'wasm_hex', seq: 0, of: 3, hash: 'abc', hex: 'aa' },
        { uid: 'c1', type: 'wasm_hex', seq: 1, of: 3, hash: 'abc', hex: 'bb' },
        { uid: 'c1', type: 'wasm_hex', seq: 2, of: 3, hash: 'abc', hex: 'cc' }
    ];
    assert.equal(events.reassembleChunks(same[0]), null);
    assert.equal(events.reassembleChunks(same[1]), null);
    assert.equal(events.reassembleChunks(same[2]), 'aabbcc');

    // 2. Real transport chunk envelopes with distinct uid#seq and out-of-order arrival
    const realChunks = [
        { uid: 'tx42#2', type: 'wasm_hex', seq: 2, of: 3, hash: 'abc', hex: '3333' },
        { uid: 'tx42#0', type: 'wasm_hex', seq: 0, of: 3, hash: 'abc', hex: '1111' },
        { uid: 'tx42#1', type: 'wasm_hex', seq: 1, of: 3, hash: 'abc', hex: '2222' }
    ];
    assert.equal(events.reassembleChunks(realChunks[0]), null);
    assert.equal(events.reassembleChunks(realChunks[1]), null);
    assert.equal(events.reassembleChunks(realChunks[2]), '111122223333');
});

test('reassembleChunks strictly rejects malformed sequences and inconsistent envelopes', () => {
    // 1. Negative seq
    assert.equal(events.reassembleChunks({ uid: 'inv1#0', seq: -1, of: 2, hex: 'aa' }), null);

    // 2. Out of bound seq >= of
    assert.equal(events.reassembleChunks({ uid: 'inv2#2', seq: 2, of: 2, hex: 'aa' }), null);

    // 3. Non-integer seq or of
    assert.equal(events.reassembleChunks({ uid: 'inv3#0', seq: 0.5, of: 2, hex: 'aa' }), null);
    assert.equal(events.reassembleChunks({ uid: 'inv4#0', seq: 0, of: '2', hex: 'aa' }), null);
    assert.equal(events.reassembleChunks({ uid: 'inv5#0', seq: 0, of: 0, hex: 'aa' }), null);
    assert.equal(events.reassembleChunks({ uid: 'inv6#0', seq: 0, of: 5000, hex: 'aa' }), null);

    // 4. Duplicate chunk does not cause premature assembly
    assert.equal(events.reassembleChunks({ uid: 'dup#0', seq: 0, of: 2, hex: 'aa' }), null);
    assert.equal(events.reassembleChunks({ uid: 'dup#0', seq: 0, of: 2, hex: 'aa' }), null);
    assert.equal(events.reassembleChunks({ uid: 'dup#1', seq: 1, of: 2, hex: 'bb' }), 'aabb');

    // 5. Inconsistent total for same transfer ID is rejected
    assert.equal(events.reassembleChunks({ uid: 'inc#0', seq: 0, of: 3, hex: '11' }), null);
    assert.equal(events.reassembleChunks({ uid: 'inc#1', seq: 1, of: 2, hex: '22' }), null);

    // 6. Non-string hex
    assert.equal(events.reassembleChunks({ uid: 'hex#0', seq: 0, of: 1, hex: 123 }), null);
});

test('dumpWasmFromHex disambiguates colliding page hashes with content SHA-256', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-wasm-test-'));
    try {
        // Module A and Module B share identical page hash 'prefix123'
        const hexA = '0061736d01000000010401600000';
        const hexB = '0061736d01000000010401600101'; // different bytecode

        events.dumpWasmFromHex('prefix123', hexA, () => testDir);
        events.dumpWasmFromHex('prefix123', hexB, () => testDir);

        const files = fs.readdirSync(path.join(testDir, 'wasm'));
        assert.equal(files.length, 2, 'Both modules must be preserved without overwriting');
        assert.ok(files.some(f => f.startsWith('module_prefix123')));
        assert.ok(files.some(f => f.includes('_')));
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test('structuredToLegacy preserves the [Reversed-Event] wire format', () => {
    const t = events.structuredToLegacy({
        type: 'fetch',
        data: { method: 'POST', url: 'https://api.webcryptotest.hainahola.store/pay', video: false, body: 'a=1' }
    });
    assert.equal(t, '[Reversed-Event] fetch [POST] https://api.webcryptotest.hainahola.store/pay body: a=1');

    const v = events.structuredToLegacy({
        type: 'fetch',
        data: { method: 'GET', url: 'https://cdn.webcryptotest.hainahola.store/v/index.m3u8', video: true, body: null }
    });
    assert.equal(v, '[Reversed-Event] VIDEO [GET] https://cdn.webcryptotest.hainahola.store/v/index.m3u8');

    const s = events.structuredToLegacy({
        type: 'storage',
        data: { storage: 'localStorage', key: 'token', value: 'abc' }
    });
    assert.equal(s, '[Reversed-Event] STORAGE [localStorage] set token = abc');

    const cr = events.structuredToLegacy({
        type: 'crypto_result',
        data: { method: 'decrypt', result: '{"len":16,"hex":"aabb"}' }
    });
    assert.equal(cr, '[Reversed-Event] CRYPTO-RESULT decrypt {"len":16,"hex":"aabb"}');

    assert.equal(events.structuredToLegacy({ type: 'mystery', data: {} }), null);
});

test('handleStructuredEvent consumes valid envelopes end-to-end', () => {
    const evt = { uid: 'e2e-1', type: 'crypto_args', data: { method: 'decrypt', args: '[{"name":"AES-CBC","iv":{"hex":"aabb"}}]' } };
    assert.equal(events.handleStructuredEvent(JSON.stringify(evt), 'test:target', () => null), true);
    assert.equal(events.handleStructuredEvent(JSON.stringify(evt), 'test:target', () => null), true, 'duplicate uid consumed silently');

    const resEvt = { uid: 'e2e-2', type: 'crypto_result', data: { method: 'decrypt', result: '{"len":16,"hex":"aabb"}' } };
    assert.equal(events.handleStructuredEvent(JSON.stringify(resEvt), 'test:target', () => null), true);

    assert.equal(events.handleStructuredEvent('not json', 't', () => null), false);
    assert.equal(events.handleStructuredEvent('{"no":"type"}', 't', () => null), false);
});

test('formatHookConsole keeps legacy tag rendering', () => {
    const out = events.formatHookConsole('[Reversed-Event] CRYPTO-ARGS encrypt [{"a":1}]');
    assert.ok(out.includes('CRYPTO ARGS'));
    const resOut = events.formatHookConsole('[Reversed-Event] CRYPTO-RESULT decrypt {"hex":"aabb"}');
    assert.ok(resOut.includes('CRYPTO RESULT'));
    const blob = events.formatHookConsole('[Reversed-Event] BLOB URL blob:x type=text/javascript size=10B');
    assert.ok(blob.includes('BLOB URL'));
});

test('dumpWasmFromHex works when extractDirGetter is omitted', () => {
    assert.doesNotThrow(() => {
        events.dumpWasmFromHex('deadbeef123', '0061736d01000000');
    });
    // Cleanup generated module in wasm_modules if created in cwd
    try {
        const p = path.join(process.cwd(), 'wasm_modules', 'module_deadbeef123.wasm');
        if (fs.existsSync(p)) fs.unlinkSync(p);
        fs.rmdirSync(path.join(process.cwd(), 'wasm_modules'));
    } catch (e) {}
});
