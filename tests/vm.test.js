'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVMState, handleVMPause } = require('../src/cdp/vm');

test('createVMState: parses location string and watch registers', () => {
    const vmState = createVMState([
        { locStr: 'vm_engine.js:145:4', watch: ['pc', 'op', 'stack[sp]'], maxHits: 50 }
    ]);

    assert.equal(vmState.specs.length, 1);
    const spec = vmState.specs[0];
    assert.equal(spec.urlRegex, 'vm_engine.js');
    assert.equal(spec.line, 145);
    assert.equal(spec.column, 4);
    assert.deepEqual(spec.watch, ['pc', 'op', 'stack[sp]']);
    assert.equal(spec.maxHits, 50);
});

test('handleVMPause: logs registers and increments hits', async () => {
    const vmState = createVMState([
        { locStr: 'engine.js:50', watch: ['pc', 'op'] }
    ]);
    vmState.bpMap.set('bp-vm-1', 0);

    const mockCdp = {
        async send(method, params) {
            if (method === 'Debugger.evaluateOnCallFrame') {
                if (params.expression === 'pc') return { result: { value: 12 } };
                if (params.expression === 'op') return { result: { value: 'LOAD_CONST' } };
            }
            return { result: {} };
        }
    };

    const handled = await handleVMPause(
        mockCdp,
        {
            hitBreakpoints: ['bp-vm-1'],
            callFrames: [{ callFrameId: 'cf-1' }]
        },
        vmState,
        'test:main'
    );

    assert.equal(handled, true);
    assert.equal(vmState.specs[0].hits, 1);
});

test('handleVMPause: returns false if breakpoint does not match VM watch', async () => {
    const vmState = createVMState([]);
    const handled = await handleVMPause({}, { hitBreakpoints: ['bp-other'] }, vmState, 'test');
    assert.equal(handled, false);
});
