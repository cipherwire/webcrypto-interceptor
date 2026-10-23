'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unpackStrings } = require('../src/cdp/strings');

test('unpackStrings: collects valid strings and stops on consecutive misses', async () => {
    let invocations = 0;
    const mockTable = {
        '0': 'alpha',
        '1': 'beta',
        '2': 'gamma'
    };

    const mockCdp = {
        async send(method, params) {
            assert.equal(method, 'Runtime.evaluate');
            // Execute the generated expression directly in a real V8 context!
            const runner = new Function('_0xdecoder', 'return ' + params.expression);
            const res = runner((idx) => {
                invocations++;
                if (mockTable[String(idx)]) return mockTable[String(idx)];
                return null;
            });
            return { result: { value: res } };
        }
    };

    const res = await unpackStrings(mockCdp, '_0xdecoder', {
        start: 0,
        count: 20,
        batchSize: 10,
        maxConsecutiveErrors: 3
    });

    assert.equal(res.count, 3);
    assert.deepEqual(res.decoded, {
        '0': 'alpha',
        '1': 'beta',
        '2': 'gamma'
    });
    // Should have stopped after index 5 (3 consecutive misses: 3, 4, 5)
    assert.equal(res.probed, 6);
    assert.equal(invocations, 6, 'Actual browser invocations must equal reported probed');
});

test('unpackStrings: handles exceptions gracefully and tracks probed range', async () => {
    let callCount = 0;
    const mockCdp = {
        async send() {
            callCount++;
            if (callCount === 1) {
                return { result: { type: 'string', value: 'secret_token' } };
            }
            throw new Error('Evaluation failed');
        }
    };

    const res = await unpackStrings(mockCdp, 'getStr', {
        start: 10,
        count: 5,
        batchSize: 1,
        maxConsecutiveErrors: 2
    });

    assert.equal(res.count, 1);
    assert.equal(res.decoded['10'], 'secret_token');
    assert.equal(res.range.start, 10);
});

test('unpackStrings: batched evaluation reduces CDP calls by order of magnitude', async () => {
    let cdpCalls = 0;
    const mockCdp = {
        async send(method, params) {
            cdpCalls++;
            assert.equal(method, 'Runtime.evaluate');
            const runner = new Function('tableDecoder', 'return ' + params.expression);
            const res = runner((idx) => 'unpacked_val_' + idx);
            return { result: { value: res } };
        }
    };

    const res = await unpackStrings(mockCdp, 'tableDecoder', {
        start: 0,
        count: 128,
        batchSize: 64
    });

    assert.equal(res.count, 128);
    assert.equal(cdpCalls, 2, 'Must only perform 2 CDP calls for 128 items with batchSize 64');
    assert.equal(res.decoded['0'], 'unpacked_val_0');
    assert.equal(res.decoded['127'], 'unpacked_val_127');
});

test('unpackStrings: preserves method this receiver context in batch evaluation', async () => {
    const decryptor = {
        salt: 'key_',
        getString(idx) {
            if (!this || this.salt !== 'key_') throw new Error('Receiver (this) lost!');
            if (idx === 0) return this.salt + 'first';
            if (idx === 1) return this.salt + 'second';
            return null;
        }
    };

    const mockCdp = {
        async send(method, params) {
            assert.equal(method, 'Runtime.evaluate');
            // Execute in scope where decryptor is present
            const runner = new Function('decryptor', 'return ' + params.expression);
            const res = runner(decryptor);
            return { result: { value: res } };
        }
    };

    const res = await unpackStrings(mockCdp, 'decryptor.getString', {
        start: 0,
        count: 10,
        batchSize: 5,
        maxConsecutiveErrors: 2
    });

    assert.equal(res.count, 2);
    assert.equal(res.decoded['0'], 'key_first');
    assert.equal(res.decoded['1'], 'key_second');
});

test('unpackStrings: tolerates leading misses before first valid string without stopping', async () => {
    let invocations = 0;
    const sparseTable = {
        '5': 'five',
        '6': 'six'
    };

    const mockCdp = {
        async send(method, params) {
            const runner = new Function('sparseDecoder', 'return ' + params.expression);
            const res = runner((idx) => {
                invocations++;
                return sparseTable[String(idx)] || null;
            });
            return { result: { value: res } };
        }
    };

    const res = await unpackStrings(mockCdp, 'sparseDecoder', {
        start: 0,
        count: 20,
        batchSize: 20,
        maxConsecutiveErrors: 2
    });

    assert.equal(res.count, 2);
    assert.equal(res.decoded['5'], 'five');
    assert.equal(res.decoded['6'], 'six');
    // Misses at 0..4 (5 misses, which exceeds 2, but allowed because no hit yet)
    // Hits at 5, 6
    // Misses at 7, 8 (2 misses -> stops at 8)
    // Probed should be 9 (0 through 8)
    assert.equal(res.probed, 9);
    assert.equal(invocations, 9);
});
