// Invisible hooks on arbitrary site functions, driven by --hook / --hook-return / --trace-flow.
//
// Mechanism (breakpoint-based, nothing is wrapped or replaced):
//   1. Runtime.evaluate resolves the user expression to a live function
//      objectId *per execution context* (window differs per frame/worker).
//   2. Debugger.setBreakpointOnFunctionCall(objectId) pauses the page on
//      every call - fn.toString(), Proxy traps and monkeypatch detectors
//      still see the untouched native function.
//   3. For --hook-return / --trace-flow, the first entry pause reveals the function's
//      location; Debugger.getPossibleBreakpoints(restrictToFunction) then
//      arms breakpoints on every `return` location, where the top frame's
//      returnValue is readable while the arguments are still in scope.
//      That yields (input -> output) pairs - the corpus format consumed
//      by scripts/verify-reimpl.js.
//   4. If --trace-flow is enabled, the caller frame is inspected to follow
//      the downstream consumer and variable receiving the return value.
//
// State is per CDP session: executionContextIds are only unique within one
// session, so session-scoped maps (WeakMap on the session) avoid collisions
// between concurrently attached targets.
const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { trackEvent } = require('../util/summary');
const { recordDataflow } = require('./dataflow');
const { HOOK_MAX_RECORDS, HOOK_PRINT_FIRST, HOOK_PRINT_EVERY } = require('../config');

const ARGS_EXPR = 'JSON.stringify(Array.prototype.slice.call(arguments))';

// Hook expressions are evaluated once per execution context, which races page
// script execution: a function defined by a <script> tag usually does not
// exist yet, the arm pass sees `undefined`, and the hook never fires. Unresolved
// expressions are therefore re-evaluated on a short timer until they resolve,
// the context dies, or the attempt budget runs out. Interval/attempts are
// overridable through createHookState opts for unit tests.
const HOOK_REARM_INTERVAL_MS = 1000;
const HOOK_REARM_MAX_ATTEMPTS = 15;

// Per-session hook state. hookSpecs: [{ expr, captureReturn, traceFlow }]
function createHookState(hookSpecs, opts) {
    const options = opts || {};
    const specs = (hookSpecs || []).map(s => ({
        expr: s.expr,
        label: s.expr,
        captureReturn: !!s.captureReturn,
        traceFlow: !!s.traceFlow,
        records: 0,          // call records stored (capped)
        pairs: 0,            // (input,output) pairs stored
        seen: 0,             // total pauses seen (for print throttle)
        returnBpsSet: false  // return-location breakpoints armed yet?
    }));
    return {
        specs,
        callBp: new Map(),   // breakpointId -> spec index
        retBp: new Map(),    // breakpointId -> spec index
        rearmIntervalMs: Number.isFinite(options.rearmIntervalMs) ? options.rearmIntervalMs : HOOK_REARM_INTERVAL_MS,
        rearmMaxAttempts: Number.isFinite(options.rearmMaxAttempts) ? options.rearmMaxAttempts : HOOK_REARM_MAX_ATTEMPTS
    };
}

// Session-scoped bookkeeping of what was armed per execution context.
// Keyed WeakMap(session) -> Map(contextId -> { breakpointIds, objectIds })
const sessionArmed = new WeakMap();

function armedFor(session) {
    let m = sessionArmed.get(session);
    if (!m) { m = new Map(); sessionArmed.set(session, m); }
    return m;
}

async function armHooks(cdpSession, hookState, targetLabel, contextId) {
    if (!hookState.specs.length) return 0;
    // Always store the per-context record: even when nothing arms on the first
    // pass, the re-arm timer and cleanupHookContexts need it to exist.
    const perContext = { breakpointIds: [], objectIds: [], rearmTimer: null, rearmAttempts: 0 };
    armedFor(cdpSession).set(contextId, perContext);
    let armed = 0;
    const unresolved = [];
    for (let i = 0; i < hookState.specs.length; i++) {
        const spec = hookState.specs[i];
        try {
            const fn = await cdpSession.send('Runtime.evaluate', {
                expression: spec.expr,
                contextId,
                silent: true
            });
            if (!(fn.result && fn.result.type === 'function' && fn.result.objectId)) {
                unresolved.push(i);
                continue;
            }
            perContext.objectIds.push(fn.result.objectId);
            const bp = await cdpSession.send('Debugger.setBreakpointOnFunctionCall', {
                objectId: fn.result.objectId
            });
            if (bp.breakpointId) {
                hookState.callBp.set(bp.breakpointId, i);
                perContext.breakpointIds.push(bp.breakpointId);
                armed++;
            } else {
                unresolved.push(i);
            }
        } catch { /* expression may not resolve in this context */ unresolved.push(i); }
    }
    if (armed) {
        console.log(`${C.magenta}[🪝 HOOK ARMED]${C.reset} ${armed} function hook(s) on ${C.cyan}${targetLabel}${C.reset} (context ${contextId})`);
    }
    if (unresolved.length) {
        scheduleHookRearm(cdpSession, hookState, targetLabel, contextId, perContext, unresolved);
    }
    return armed;
}

// Re-evaluate hook expressions that did not resolve when the context was
// created. Page scripts define their targets after the context exists, so the
// first pass loses the race; this keeps trying on a timer until the function
// appears, the context is destroyed (cleanup clears the timer), or the
// attempt budget is exhausted (e.g. a typo'd expression must not retry
// forever).
function scheduleHookRearm(cdpSession, hookState, targetLabel, contextId, perContext, unresolvedIndices) {
    if (perContext.rearmTimer) return; // a retry pass is already scheduled
    if (perContext.rearmAttempts >= hookState.rearmMaxAttempts) return;
    perContext.rearmAttempts++;
    const timer = setTimeout(async () => {
        if (perContext.rearmTimer !== timer) return; // cleaned up while waiting
        perContext.rearmTimer = null;
        const still = [];
        let armedNow = 0;
        for (const i of unresolvedIndices) {
            try {
                const fn = await cdpSession.send('Runtime.evaluate', {
                    expression: hookState.specs[i].expr,
                    contextId,
                    silent: true
                });
                if (!(fn.result && fn.result.type === 'function' && fn.result.objectId)) {
                    still.push(i);
                    continue;
                }
                perContext.objectIds.push(fn.result.objectId);
                const bp = await cdpSession.send('Debugger.setBreakpointOnFunctionCall', {
                    objectId: fn.result.objectId
                });
                if (bp.breakpointId) {
                    hookState.callBp.set(bp.breakpointId, i);
                    perContext.breakpointIds.push(bp.breakpointId);
                    armedNow++;
                } else {
                    still.push(i);
                }
            } catch {
                return; // context gone; cleanupHookContexts already ran
            }
        }
        if (armedNow) {
            console.log(`${C.magenta}[🪝 HOOK REARMED]${C.reset} ${armedNow} hook(s) appeared later on ${C.cyan}${targetLabel}${C.reset} (context ${contextId})`);
        }
        if (still.length) {
            scheduleHookRearm(cdpSession, hookState, targetLabel, contextId, perContext, still);
        }
    }, hookState.rearmIntervalMs);
    perContext.rearmTimer = timer;
    if (typeof timer.unref === 'function') timer.unref(); // never keep the process alive for a retry
}

// Tear down everything armed for contexts that just died.
async function cleanupHookContexts(cdpSession, destroyedContextIds, hookState) {
    const perSession = armedFor(cdpSession);
    for (const contextId of destroyedContextIds) {
        const record = perSession.get(contextId);
        if (!record) continue;
        if (record.rearmTimer) {
            clearTimeout(record.rearmTimer);
            record.rearmTimer = null;
        }
        for (const bpId of record.breakpointIds) {
            try { await cdpSession.send('Debugger.removeBreakpoint', { breakpointId: bpId }); } catch {}
            hookState.callBp.delete(bpId);
        }
        for (const objectId of record.objectIds) {
            try { await cdpSession.send('Runtime.releaseObject', { objectId }); } catch {}
        }
        perSession.delete(contextId);
    }
}

// Lazily arm breakpoints on every `return` location of the hooked function.
async function setReturnBreakpoints(cdpSession, hookState, specIdx, topFrame) {
    const spec = hookState.specs[specIdx];
    const loc = topFrame.functionLocation;
    if (!loc) return 0;
    let locations = [];
    try {
        const r = await cdpSession.send('Debugger.getPossibleBreakpoints', {
            start: loc,
            restrictToFunction: true
        });
        locations = r.locations || [];
    } catch { return 0; }
    let count = 0;
    for (const rl of locations) {
        if (rl.type !== 'return') continue;
        try {
            const bp = await cdpSession.send('Debugger.setBreakpoint', { location: rl });
            if (bp.breakpointId) {
                hookState.retBp.set(bp.breakpointId, specIdx);
                count++;
            }
        } catch {}
    }
    if (!count) {
        console.log(`${C.yellow}[🪝 HOOK] no return location found for ${spec.label} - corpus stays call-args-only${C.reset}`);
    }
    return count;
}

async function readArgs(cdpSession, callFrameId) {
    try {
        const r = await cdpSession.send('Debugger.evaluateOnCallFrame', {
            callFrameId,
            expression: ARGS_EXPR,
            returnByValue: true,
            silent: true
        });
        const v = r.result && r.result.value;
        if (typeof v === 'string') {
            try { return JSON.parse(v); } catch { return v; }
        }
        return v;
    } catch (e) {
        return `<args unavailable: ${String(e.message || e).substring(0, 80)}>`;
    }
}

// Entry pause on a hooked function: log the call, and lazily arm return
// breakpoints when the hook wants (input,output) pairs.
async function recordHookCall(cdpSession, hookState, specIdx, params, targetLabel) {
    const spec = hookState.specs[specIdx];
    const frames = params.callFrames || [];
    const top = frames[0];
    spec.seen++;

    if (spec.captureReturn && !spec.returnBpsSet) {
        spec.returnBpsSet = true;
        try { await setReturnBreakpoints(cdpSession, hookState, specIdx, top); } catch {}
    }

    if (spec.records < HOOK_MAX_RECORDS) {
        spec.records++;
        const args = await readArgs(cdpSession, top.callFrameId);
        const stack = frames.slice(0, 5).map(f => ({
            fn: f.functionName || '<anonymous>',
            url: f.url ? shortUrl(f.url) : '<anonymous>',
            line: f.location ? f.location.lineNumber + 1 : 0
        }));
        writeLog({ type: 'hook_call', hook: spec.label, target: targetLabel, fn: top.functionName || '<anonymous>', args, stack });
        trackEvent('hook_call');
    }

    if (spec.seen <= HOOK_PRINT_FIRST || spec.seen % HOOK_PRINT_EVERY === 0) {
        console.log(`${C.hlyel}[🪝 HOOK]${C.reset} ${C.bold}${spec.label}${C.reset} call #${spec.seen} in ${C.magenta}${targetLabel}${C.reset}`);
    }
}

// Return-location pause: arguments still in scope, returnValue available on
// the top frame -> (input, output) corpus pair for the verification oracle.
async function recordHookPair(cdpSession, hookState, specIdx, params, targetLabel) {
    const spec = hookState.specs[specIdx];
    const frames = params.callFrames || [];
    const top = frames[0];
    if (!top) return;
    spec.seen++;

    const rv = top.returnValue || {};
    let output = rv.value;
    if (output === undefined && rv.type) {
        output = null;
        writeLog({
            type: 'hook_pair_unserialized', hook: spec.label, target: targetLabel,
            output_type: rv.subtype || rv.type, description: (rv.description || '').substring(0, 200)
        });
    }

    if (spec.pairs < HOOK_MAX_RECORDS) {
        spec.pairs++;
        const input = await readArgs(cdpSession, top.callFrameId);
        writeLog({
            type: 'hook_pair', hook: spec.label, target: targetLabel,
            input, output: output === undefined ? null : output,
            output_type: rv.type || null
        });
        trackEvent('hook_pair');
    }

    if (spec.seen <= HOOK_PRINT_FIRST || spec.seen % HOOK_PRINT_EVERY === 0) {
        const preview = JSON.stringify(output) || 'undefined';
        console.log(`${C.hlyel}[🪝 HOOK PAIR]${C.reset} ${C.bold}${spec.label}${C.reset} #${spec.seen} -> ${C.green}${preview.substring(0, 160)}${C.reset} ${C.dim}(${targetLabel})${C.reset}`);
    }

    // If forward dataflow tracing is enabled, resolve consumer frame
    if (spec.traceFlow) {
        try {
            await recordDataflow(cdpSession, spec.label, frames, rv, targetLabel);
        } catch {}
    }
}

// Returns true if this pause belonged to a hook (caller still resumes).
async function handleHookPause(cdpSession, params, hookState, targetLabel) {
    if (!hookState.specs.length) return false;
    const hit = params.hitBreakpoints || [];
    const frames = params.callFrames || [];
    if (!frames.length) return false;

    let retIdx;
    for (const b of hit) { const v = hookState.retBp.get(b); if (v !== undefined) { retIdx = v; break; } }
    if (retIdx !== undefined) {
        await recordHookPair(cdpSession, hookState, retIdx, params, targetLabel);
        return true;
    }

    let callIdx;
    for (const b of hit) { const v = hookState.callBp.get(b); if (v !== undefined) { callIdx = v; break; } }
    if (callIdx === undefined) return false;

    await recordHookCall(cdpSession, hookState, callIdx, params, targetLabel);
    return true;
}

module.exports = { createHookState, armHooks, cleanupHookContexts, handleHookPause };
