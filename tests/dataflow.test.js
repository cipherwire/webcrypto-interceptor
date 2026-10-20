'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveConsumer } = require('../src/cdp/dataflow');

test('resolveConsumer: resolves consumer function and location from frames', async () => {
    const callFrames = [
        {
            functionName: 'signPayload',
            location: { lineNumber: 20, columnNumber: 5 },
            url: 'https://example.com/app.js'
        },
        {
            functionName: 'sendRequest',
            location: { lineNumber: 42, columnNumber: 12 },
            url: 'https://example.com/api.js',
            callFrameId: 'frame-1',
            scopeChain: [
                {
                    type: 'local',
                    object: { objectId: 'scope-obj-1' }
                }
            ]
        }
    ];

    const mockCdp = {
        async send(method, params) {
            if (method === 'Runtime.getProperties' && params.objectId === 'scope-obj-1') {
                return {
                    result: [
                        { name: 'irrelevant', value: { value: 123 } },
                        { name: 'authToken', value: { value: 'sig_secret_123' } }
                    ]
                };
            }
            return { result: [] };
        }
    };

    const consumer = await resolveConsumer(mockCdp, callFrames, {
        type: 'string',
        value: 'sig_secret_123'
    });

    assert.equal(consumer.function, 'sendRequest');
    assert.equal(consumer.line, 43);
    assert.equal(consumer.column, 13);
    assert.equal(consumer.variable, 'authToken');
});

test('resolveConsumer: handles top-level / missing caller frame gracefully', async () => {
    const singleFrame = [
        {
            functionName: 'topLevel',
            location: { lineNumber: 1, columnNumber: 0 }
        }
    ];

    const consumer = await resolveConsumer({}, singleFrame, { type: 'string', value: 'token' });
    assert.equal(consumer.function, '<top-level / event loop>');
    assert.equal(consumer.variable, null);
});
