'use strict';

// Runtime String Table Unpacker for obfuscated JavaScript bundles.
// Evaluates the target application's active string decoder routine across
// index ranges directly inside the Chromium V8 execution context, bypassing
// runtime array rotation and shuffle loops that defeat static deobfuscators.

/**
 * Probes and extracts the string dictionary by invoking the site's live decoder.
 *
 * @param {object} cdpSession - Puppeteer CDPSession instance
 * @param {string} decoderExpr - Expression resolving to the decoder function (e.g. "_0x1a2b")
 * @param {object} [options]
 * @param {number} [options.start=0] - Initial index to probe
 * @param {number} [options.count=512] - Maximum number of indices to probe
 * @param {Array<*>} [options.extraArgs=[]] - Secondary arguments for keyed decoders (e.g. key)
 * @param {number} [options.maxConsecutiveErrors=32] - Stop probing after N consecutive misses
 * @returns {Promise<{ decoded: Record<string, string>, count: number, range: { start: number, end: number } }>}
 */
async function unpackStrings(cdpSession, decoderExpr, options = {}) {
    const start = Number.isInteger(options.start) ? options.start : 0;
    const count = Number.isInteger(options.count) ? options.count : 512;
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    const maxConsecutiveErrors = Number.isInteger(options.maxConsecutiveErrors) ? options.maxConsecutiveErrors : 32;

    const extraArgsSuffix = extraArgs.length > 0 ? (',' + JSON.stringify(extraArgs).slice(1, -1)) : '';
    const decoded = {};
    let consecutiveErrors = 0;
    let probedCount = 0;

    for (let index = start; index < start + count; index++) {
        probedCount++;
        const expr = `/*wci:str*/(function(){ try { return (${decoderExpr})(${index}${extraArgsSuffix}); } catch(e) { return null; } })()`;

        try {
            const resp = await cdpSession.send('Runtime.evaluate', {
                expression: expr,
                returnByValue: true,
                silent: true
            });

            const result = resp && resp.result;
            if (result && result.type === 'string' && typeof result.value === 'string') {
                decoded[String(index)] = result.value;
                consecutiveErrors = 0;
            } else {
                consecutiveErrors++;
            }
        } catch {
            consecutiveErrors++;
        }

        // If we hit consecutive misses after finding at least some valid strings,
        // we have reached the end of the rotation table.
        if (consecutiveErrors >= maxConsecutiveErrors && Object.keys(decoded).length > 0) {
            break;
        }
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
