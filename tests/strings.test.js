'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unpackStrings } = require('../src/cdp/strings');

test('unpackStrings: collects valid strings and stops on consecutive misses', async () => {
    const mockTable = {
        '0': 'alpha',
        '1': 'beta',
        '2': 'gamma'
    };

    const mockCdp = {
        async send(method, params) {
            assert.equal(method, 'Runtime.evaluate');
            const match = params.expression.match(/\((\d+)\)/);
            const idx = match ? match[1] : null;

            if (idx && mockTable[idx]) {
                return { result: { type: 'string', value: mockTable[idx] } };
            }
            return { result: { type: 'undefined' } };
        }
    };

    const res = await unpackStrings(mockCdp, '_0xdecoder', {
        start: 0,
        count: 20,
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
        maxConsecutiveErrors: 2
    });

    assert.equal(res.count, 1);
    assert.equal(res.decoded['10'], 'secret_token');
    assert.equal(res.range.start, 10);
});
