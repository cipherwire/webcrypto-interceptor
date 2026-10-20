'use strict';

// Forward Dataflow & Consumer Tracer for webcrypto-interceptor.
// Observes cryptographic signers, token generators, and encoders at their
// return boundary, linking the produced payload directly to the consuming
// caller frame and identifying the downstream variable or function receiving it.

const { C } = require('../util/colors');
const { writeLog } = require('../util/log');
const { shortUrl } = require('../util/decoders');
const { trackEvent } = require('../util/summary');

/**
 * Resolves caller / consumer information from the call-stack frames at the return breakpoint.
 *
 * @param {object} cdpSession - Active CDPSession
 * @param {Array<object>} callFrames - Call frames provided in Debugger.paused event
 * @param {object} returnValue - Return value descriptor from frames[0]
 * @returns {Promise<object>} Consumer metadata
 */
async function resolveConsumer(cdpSession, callFrames, returnValue) {
    if (!callFrames || callFrames.length < 2) {
        return {
            function: '<top-level / event loop>',
            url: '',
            line: 0,
            column: 0,
            variable: null
        };
    }

    const callerFrame = callFrames[1];
    const consumer = {
        function: callerFrame.functionName || '<anonymous>',
        url: callerFrame.url ? shortUrl(callerFrame.url) : '<anonymous>',
        line: callerFrame.location ? callerFrame.location.lineNumber + 1 : 0,
        column: callerFrame.location ? callerFrame.location.columnNumber + 1 : 0,
        variable: null
    };

    // If the return value is a primitive string or number, probe caller scopeChain
    // to find which variable received or matched the value.
    if (returnValue && returnValue.value !== undefined && callerFrame.callFrameId) {
        try {
            const targetVal = returnValue.value;
            for (const scope of callerFrame.scopeChain || []) {
                if (!['local', 'block', 'closure'].includes(scope.type)) continue;
                const objectId = scope.object && scope.object.objectId;
                if (!objectId) continue;

                const props = await cdpSession.send('Runtime.getProperties', {
                    objectId,
                    ownProperties: true
                });

                for (const p of props.result || []) {
                    if (p.value && p.value.value === targetVal) {
                        consumer.variable = p.name;
                        break;
                    }
                }
                if (consumer.variable) break;
            }
        } catch {
            // Scope evaluation is best-effort
        }
    }

    return consumer;
}

/**
 * Records a dataflow trace link from producer to consumer.
 *
 * @param {object} cdpSession
 * @param {string} producerExpr
 * @param {Array<object>} callFrames
 * @param {object} returnValue
 * @param {string} targetLabel
 */
async function recordDataflow(cdpSession, producerExpr, callFrames, returnValue, targetLabel) {
    const consumer = await resolveConsumer(cdpSession, callFrames, returnValue);
    const top = callFrames[0] || {};

    const outputPreview = returnValue.value !== undefined
        ? JSON.stringify(returnValue.value)
        : (returnValue.description || returnValue.type || 'unknown');

    const trace = {
        type: 'dataflow_trace',
        producer: {
            expr: producerExpr,
            fn: top.functionName || '<anonymous>',
            url: top.url ? shortUrl(top.url) : '<anonymous>',
            line: top.location ? top.location.lineNumber + 1 : 0
        },
        consumer,
        output: returnValue.value !== undefined ? returnValue.value : null,
        output_type: returnValue.type || null,
        target: targetLabel
    };

    writeLog(trace);
    trackEvent('dataflow_trace');

    const varInfo = consumer.variable ? ` (received by ${C.cyan}${consumer.variable}${C.reset})` : '';
    console.log(`${C.magenta}[🌊 DATAFLOW]${C.reset} ${C.bold}${producerExpr}${C.reset} -> ${C.green}${outputPreview.substring(0, 100)}${C.reset} consumed by ${C.bold}${consumer.function}${C.reset} at ${consumer.url}:${consumer.line}${varInfo}`);

    return trace;
}

module.exports = {
    resolveConsumer,
    recordDataflow
};
