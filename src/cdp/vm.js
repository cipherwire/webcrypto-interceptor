'use strict';

// Bytecode VM Dispatch Loop Tracer for webcrypto-interceptor.
// Hooks client-side virtual machine interpreters and bytecode dispatchers
// at a specified script location, evaluating watched registers and operands
// on every execution cycle.

const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { trackEvent } = require('../util/summary');

/**
 * Creates state for tracking VM dispatch loop breakpoints.
 *
 * @param {Array<{ locStr: string, watch: Array<string>, maxHits: number }>} vmSpecs
 * @returns {object} VM watch state
 */
function createVMState(vmSpecs) {
    const specs = (vmSpecs || []).map(s => {
        const parts = s.locStr.split(':');
        const urlRegex = parts[0] || '';
        const line = parseInt(parts[1], 10) || 1;
        const column = parseInt(parts[2], 10) || 0;
        return {
            locStr: s.locStr,
            urlRegex,
            line,
            column,
            watch: Array.isArray(s.watch) ? s.watch : [],
            maxHits: s.maxHits || 300,
            hits: 0
        };
    });

    return {
        specs,
        bpMap: new Map() // breakpointId -> spec index
    };
}

/**
 * Arms VM dispatch breakpoints across an active CDP session.
 *
 * @param {object} cdpSession
 * @param {object} vmState
 * @param {string} targetLabel
 */
async function armVMWatchers(cdpSession, vmState, targetLabel) {
    if (!vmState || !vmState.specs.length) return 0;
    let armed = 0;

    for (let i = 0; i < vmState.specs.length; i++) {
        const spec = vmState.specs[i];
        try {
            const resp = await cdpSession.send('Debugger.setBreakpointByUrl', {
                urlRegex: spec.urlRegex,
                lineNumber: spec.line - 1,
                columnNumber: spec.column
            });

            if (resp && resp.breakpointId) {
                vmState.bpMap.set(resp.breakpointId, i);
                armed++;
                console.log(`${C.magenta}[🧬 VM WATCH ARMED]${C.reset} Watching ${C.bold}${spec.locStr}${C.reset} on ${C.cyan}${targetLabel}${C.reset} (registers: ${spec.watch.join(', ') || 'all'})`);
            }
        } catch {
            // Script might not be loaded yet or location invalid
        }
    }

    return armed;
}

/**
 * Handles a breakpoint pause if it corresponds to an armed VM dispatch loop.
 *
 * @param {object} cdpSession
 * @param {object} params - Debugger.paused params
 * @param {object} vmState
 * @param {string} targetLabel
 * @returns {Promise<boolean>} True if handled as a VM breakpoint
 */
async function handleVMPause(cdpSession, params, vmState, targetLabel) {
    if (!vmState || !vmState.specs.length) return false;
    const hitBreakpoints = params.hitBreakpoints || [];
    const callFrames = params.callFrames || [];
    if (!callFrames.length) return false;

    let specIdx;
    for (const b of hitBreakpoints) {
        if (vmState.bpMap.has(b)) {
            specIdx = vmState.bpMap.get(b);
            break;
        }
    }

    if (specIdx === undefined) return false;

    const spec = vmState.specs[specIdx];
    spec.hits++;
    const topFrame = callFrames[0];

    const registers = {};
    for (const expr of spec.watch) {
        try {
            const ev = await cdpSession.send('Debugger.evaluateOnCallFrame', {
                callFrameId: topFrame.callFrameId,
                expression: expr,
                returnByValue: true,
                silent: true
            });
            registers[expr] = ev && ev.result ? ev.result.value : null;
        } catch {
            registers[expr] = '<eval-error>';
        }
    }

    const event = {
        type: 'vm_step',
        vm: spec.locStr,
        hit: spec.hits,
        target: targetLabel,
        registers
    };

    writeLog(event);
    trackEvent('vm_step');

    if (spec.hits <= 10 || spec.hits % 50 === 0) {
        const regStr = Object.entries(registers).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
        console.log(`${C.dim}[VM #${spec.hits}]${C.reset} ${C.bold}${spec.locStr}${C.reset} ${C.green}${regStr}${C.reset}`);
    }

    return true;
}

module.exports = {
    createVMState,
    armVMWatchers,
    handleVMPause
};
