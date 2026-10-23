'use strict';

// Runtime String Table Unpacker for obfuscated JavaScript bundles.
// Evaluates the target application's active string decoder routine across
// index ranges directly inside the Chromium V8 execution context, bypassing
// runtime array rotation and shuffle loops that defeat static deobfuscators.

/**
 * Probes and extracts the string dictionary by invoking the site's live decoder.
 * Supports batched evaluation to reduce CDP IPC round-trips by an order of magnitude.
 *
 * @param {object} cdpSession - Puppeteer CDPSession instance
 * @param {string} decoderExpr - Expression resolving to the decoder function (e.g. "_0x1a2b")
 * @param {object} [options]
 * @param {number} [options.start=0] - Initial index to probe
 * @param {number} [options.count=512] - Maximum number of indices to probe
 * @param {number} [options.batchSize=64] - Number of indices evaluated per CDP round-trip
 * @param {Array<*>} [options.extraArgs=[]] - Secondary arguments for keyed decoders (e.g. key)
 * @param {number} [options.maxConsecutiveErrors=32] - Stop probing after N consecutive misses
 * @returns {Promise<{ decoded: Record<string, string>, count: number, probed: number, range: { start: number, end: number } }>}
 */
async function unpackStrings(cdpSession, decoderExpr, options = {}) {
    const start = Number.isInteger(options.start) ? options.start : 0;
    const count = Number.isInteger(options.count) ? options.count : 512;
    const batchSize = (Number.isInteger(options.batchSize) && options.batchSize > 0) ? options.batchSize : 64;
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    const maxConsecutiveErrors = Number.isInteger(options.maxConsecutiveErrors) ? options.maxConsecutiveErrors : 32;

    const extraArgsSuffix = extraArgs.length > 0 ? (',' + JSON.stringify(extraArgs).slice(1, -1)) : '';
    const decoded = {};
    let consecutiveErrors = 0;
    let probedCount = 0;

    for (let batchStart = start; batchStart < start + count; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, start + count);

        if (batchSize === 1) {
            probedCount++;
            const expr = `/*wci:str*/(function(){ try { return (${decoderExpr})(${batchStart}${extraArgsSuffix}); } catch(e) { return null; } })()`;
            try {
                const resp = await cdpSession.send('Runtime.evaluate', {
                    expression: expr,
                    returnByValue: true,
                    silent: true
                });
                const result = resp && resp.result;
                if (result && result.type === 'string' && typeof result.value === 'string') {
                    decoded[String(batchStart)] = result.value;
                    consecutiveErrors = 0;
                } else {
                    consecutiveErrors++;
                }
            } catch {
                consecutiveErrors++;
            }
            if (consecutiveErrors >= maxConsecutiveErrors && Object.keys(decoded).length > 0) {
                break;
            }
            continue;
        }

        // Batched evaluation: probe a chunk in a single CDP round-trip
        const expr = `/*wci:str_batch*/(function(){ var res = {}; var fn; try { fn = (${decoderExpr}); } catch(e) { return res; } if (typeof fn !== 'function') return res; for (var i = ${batchStart}; i < ${batchEnd}; i++) { try { var v = fn(i${extraArgsSuffix}); if (typeof v === 'string') res[i] = v; } catch(e) {} } return res; })()`;

        let batchRes = null;
        try {
            const resp = await cdpSession.send('Runtime.evaluate', {
                expression: expr,
                returnByValue: true,
                silent: true
            });
            const result = resp && resp.result;
            if (result && result.value && typeof result.value === 'object') {
                batchRes = result.value;
            }
        } catch {
            batchRes = null;
        }

        let earlyStop = false;
        for (let i = batchStart; i < batchEnd; i++) {
            probedCount++;
            const strVal = batchRes && batchRes[i];
            if (typeof strVal === 'string') {
                decoded[String(i)] = strVal;
                consecutiveErrors = 0;
            } else {
                consecutiveErrors++;
            }

            if (consecutiveErrors >= maxConsecutiveErrors && Object.keys(decoded).length > 0) {
                earlyStop = true;
                break;
            }
        }

        if (earlyStop) break;
    }

    return {
        decoded,
        count: Object.keys(decoded).length,
        probed: probedCount,
        range: { start, end: start + probedCount - 1 }
    };
}

module.exports = {
    unpackStrings
};
