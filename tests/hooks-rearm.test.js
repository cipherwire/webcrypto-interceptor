'use strict';

// Unit tests for the hook re-arm loop: expressions that do not resolve at
// execution-context creation (page scripts define their targets later) must
// be re-evaluated on a timer until they resolve, and the retry timer must be
// cancelled when the context is destroyed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHookState, armHooks, cleanupHookContexts } = require('../src/cdp/hooks');

const REARM = { rearmIntervalMs: 20, rearmMaxAttempts: 10 };

function mockSession(resolveOnCall) {
    const calls = { evaluate: 0, setBp: 0, removed: 0, released: 0 };
    const session = {
        async send(method) {
            if (method === 'Runtime.evaluate') {
                calls.evaluate++;
                return resolveOnCall(calls.evaluate)
                    ? { result: { type: 'function', objectId: 'obj-' + calls.evaluate } }
                    : { result: { type: 'undefined' } };
            }
            if (method === 'Debugger.setBreakpointOnFunctionCall') {
                calls.setBp++;
                return { breakpointId: 'bp-' + calls.setBp };
            }
            if (method === 'Debugger.removeBreakpoint') { calls.removed++; return {}; }
            if (method === 'Runtime.releaseObject') { calls.released++; return {}; }
            throw new Error('unexpected CDP method: ' + method);
        },
        on() {}
    };
    return { session, calls };
}

async function waitFor(cond, timeoutMs, stepMs = 10) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await new Promise(r => setTimeout(r, stepMs));
    }
    return cond();
}

test('rearm: hook that appears later is picked up by the retry loop', async () => {
    const { session, calls } = mockSession(n => n >= 3); // resolves on 3rd evaluate
    const state = createHookState([{ expr: 'window.lateFn', captureReturn: false, traceFlow: false }], REARM);

    const armed = await armHooks(session, state, 't', 1);
    assert.equal(armed, 0, 'first pass must not arm anything');
    assert.equal(state.callBp.size, 0);

    const ok = await waitFor(() => state.callBp.size > 0, 2000);
    assert.ok(ok, 'rearm loop must arm the hook once the expression resolves');
    assert.equal(state.callBp.size, 1);
    assert.equal(calls.evaluate >= 3, true, 'several retries expected before resolution');
});

test('rearm: immediate resolution arms synchronously and schedules nothing', async () => {
    const { session, calls } = mockSession(() => true);
    const state = createHookState([{ expr: 'window.earlyFn', captureReturn: false, traceFlow: false }], REARM);

    const armed = await armHooks(session, state, 't', 1);
    assert.equal(armed, 1);
    assert.equal(state.callBp.size, 1);

    const before = calls.evaluate;
    await new Promise(r => setTimeout(r, 80));
    assert.equal(calls.evaluate, before, 'no retry evaluations expected after full arming');
});

test('rearm: never-resolving expression stops after the attempt budget', async () => {
    const { session, calls } = mockSession(() => false);
    const state = createHookState([{ expr: 'window.nope', captureReturn: false, traceFlow: false }],
        { rearmIntervalMs: 10, rearmMaxAttempts: 3 });

    await armHooks(session, state, 't', 1);
    const reached = await waitFor(() => calls.evaluate >= 4, 2000); // 1 initial + 3 retries
    assert.ok(reached, 'all retry attempts should run');
    const settled = calls.evaluate;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(calls.evaluate, settled, 'no evaluations beyond the attempt budget');
});

test('rearm: cleanupHookContexts cancels the pending retry timer', async () => {
    const { session, calls } = mockSession(() => false);
    const state = createHookState([{ expr: 'window.nope', captureReturn: false, traceFlow: false }], REARM);

    await armHooks(session, state, 't', 1);
    const before = calls.evaluate;
    await cleanupHookContexts(session, [1], state);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(calls.evaluate, before, 'no evaluations after the context was destroyed');
    assert.equal(state.callBp.size, 0);
});

test('rearm: cleanup releases object ids and removes breakpoints of rearmed hooks', async () => {
    const { session, calls } = mockSession(n => n >= 2);
    const state = createHookState([{ expr: 'window.lateFn', captureReturn: false, traceFlow: false }], REARM);

    await armHooks(session, state, 't', 1);
    await waitFor(() => state.callBp.size > 0, 2000);
    await cleanupHookContexts(session, [1], state);
    assert.equal(calls.removed, 1, 'breakpoint from the rearm pass must be removed');
    assert.equal(calls.released >= 1, true, 'object id from the rearm pass must be released');
    assert.equal(state.callBp.size, 0);
});
