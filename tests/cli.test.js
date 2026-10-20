const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgv, HELP } = require('../src/cli');

test('parses basic URL', () => {
    const o = parseArgv(['https://webcryptotest.hainahola.store']);
    assert.equal(o.url, 'https://webcryptotest.hainahola.store');
    assert.equal(o.gui, false);
    assert.equal(o.brave, false);
    assert.equal(o.full, false);
    assert.equal(o.allTraffic, false);
    assert.equal(o.timeout, 60000);
});

test('parses --brave flag', () => {
    const o = parseArgv(['https://webcryptotest.hainahola.store', '--brave']);
    assert.equal(o.brave, true);
});

test('parses flags and values', () => {
    const o = parseArgv(['https://webcryptotest.hainahola.store', '--gui', '--full', '--out', '/tmp/dumps', '--timeout', '90', '--all-traffic']);
    assert.equal(o.gui, true);
    assert.equal(o.full, true);
    assert.equal(o.out, '/tmp/dumps');
    assert.equal(o.timeout, 90000);
    assert.equal(o.allTraffic, true);
});

test('accepts url + proxy + ua', () => {
    const o = parseArgv(['http://10.0.0.1/', '--proxy', 'http://127.0.0.1:8080', '--ua', 'MyAgent/1.0']);
    assert.equal(o.proxy, 'http://127.0.0.1:8080');
    assert.equal(o.ua, 'MyAgent/1.0');
    assert.equal(o.url, 'http://10.0.0.1/');
});

test('rejects missing URL', () => {
    assert.throws(() => parseArgv([]), /Missing <URL>/);
});

test('rejects non-http URL', () => {
    assert.throws(() => parseArgv(['ftp://webcryptotest.hainahola.store']), /http/);
    assert.throws(() => parseArgv(['webcryptotest.hainahola.store']), /http/);
});

test('rejects invalid timeout', () => {
    assert.throws(() => parseArgv(['https://webcryptotest.hainahola.store', '--timeout', '-5']), /timeout/);
    assert.throws(() => parseArgv(['https://webcryptotest.hainahola.store', '--timeout', 'abc']), /timeout/);
});

test('--help short-circuits', () => {
    const o = parseArgv(['--help']);
    assert.equal(o.help, true);
    assert.ok(HELP.includes('--gui'));
    assert.ok(HELP.includes('--brave'));
    assert.ok(HELP.includes('webcrypto-interceptor'));
});

test('parses repeatable --hook, --hook-return, and --trace-flow', () => {
    const o = parseArgv([
        'https://webcryptotest.hainahola.store',
        '--hook', 'window.a',
        '--hook', 'window.b',
        '--hook-return', 'window.sign',
        '--trace-flow', 'window.buildPayload'
    ]);
    assert.deepEqual(o.hooks, [
        { expr: 'window.a', captureReturn: false, traceFlow: false },
        { expr: 'window.b', captureReturn: false, traceFlow: false }
    ]);
    assert.deepEqual(o.hookReturns, [
        { expr: 'window.sign', captureReturn: true, traceFlow: false }
    ]);
    assert.deepEqual(o.traceFlows, [
        { expr: 'window.buildPayload', captureReturn: true, traceFlow: true }
    ]);
});

test('parses --dump-strings decoder expression', () => {
    const o = parseArgv(['https://webcryptotest.hainahola.store', '--dump-strings', '_0x1a2b']);
    assert.equal(o.dumpStrings, '_0x1a2b');
});

test('parses --trace-vm and --watch expressions', () => {
    const o = parseArgv([
        'https://webcryptotest.hainahola.store',
        '--trace-vm', 'engine.js:142:4',
        '--watch', 'pc, opcode, stack[sp]'
    ]);
    assert.deepEqual(o.traceVM, [
        { locStr: 'engine.js:142:4', watch: ['pc', 'opcode', 'stack[sp]'] }
    ]);
});

test('parses --heap-diff seconds', () => {
    const o = parseArgv(['https://webcryptotest.hainahola.store', '--heap-diff', '30']);
    assert.equal(o.heapDiff, 30);
});

test('defaults: no hooks, heap diff disabled', () => {
    const o = parseArgv(['https://webcryptotest.hainahola.store']);
    assert.deepEqual(o.hooks, []);
    assert.deepEqual(o.hookReturns, []);
    assert.deepEqual(o.traceFlows, []);
    assert.equal(o.dumpStrings, null);
    assert.deepEqual(o.traceVM, []);
    assert.equal(o.heapDiff, 0);
});

test('rejects empty hook expression', () => {
    assert.throws(() => parseArgv(['https://webcryptotest.hainahola.store', '--hook', '   ']), /must not be empty/);
    assert.throws(() => parseArgv(['https://webcryptotest.hainahola.store', '--hook-return', '']), /must not be empty/);
    assert.throws(() => parseArgv(['https://webcryptotest.hainahola.store', '--trace-flow', '']), /must not be empty/);
});

test('rejects invalid heap-diff', () => {
    assert.throws(() => parseArgv(['https://webcryptotest.hainahola.store', '--heap-diff=-5']), /non-negative/);
    assert.throws(() => parseArgv(['https://webcryptotest.hainahola.store', '--heap-diff', 'abc']), /non-negative/);
});

test('C.hlyel is defined and valid ANSI code', () => {
    const { C } = require('../src/util/colors');
    assert.equal(typeof C.hlyel, 'string');
    assert.ok(C.hlyel.startsWith('\x1b['));
});
