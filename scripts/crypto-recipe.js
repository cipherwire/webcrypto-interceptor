#!/usr/bin/env node
// crypto-recipe.js - reconstruct the client-side crypto protocol a site ran,
// from a session_capture_*.jsonl log.
//
// Streaming sites guard streams with a *protocol*, not a single call: solve a
// proof-of-work (digest loops), sign the request, decrypt the stream config,
// encrypt telemetry. Reading 13 raw [CRYPTO BOUNDARY] lines by hand is slow;
// this replays them in order, collapses PoW-style bursts, and prints the
// recipe per target - the checklist you would follow to reimplement access.
//
// With a 0.4.2+ capture, each step also shows the serialized call arguments
// (keys, IVs, plaintexts) recorded by the CDP boundary.
//
// Usage: node scripts/crypto-recipe.js [session_capture_*.jsonl] [--json]
// (defaults to the newest session_capture_*.jsonl in the cwd)

const fs = require('fs');

// Collapse one target's ordered crypto_call records into recipe steps:
// identical (method, caller) runs merge ("digest x5"), and digest bursts of
// >= POW_MIN consecutive calls are flagged as proof-of-work loops.
function buildRecipe(records) {
    const POW_MIN = 3;
    const steps = [];
    for (const r of records) {
        const step = {
            method: (r.method || '').replace('crypto.subtle.', ''),
            caller: r.caller || '<anonymous>',
            loc: r.stack && r.stack[0] && r.stack[0].url
                ? `${r.stack[0].url.split('/').pop() || 'inline'}:${(r.stack[0].line || 0) + 1}`
                : null,
            args: r.args || null,
            ts: r.timestamp,
            pow: false
        };
        const prev = steps[steps.length - 1];
        if (prev && prev.method === step.method && prev.caller === step.caller) {
            prev.count = (prev.count || 1) + 1;
            if (step.args !== null && prev.args === null) prev.args = step.args;
            continue;
        }
        steps.push(Object.assign(step, { count: 1 }));
    }
    // Flag PoW-shaped bursts (only after merging, on fresh step boundaries)
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.method === 'digest' && (s.count || 1) >= POW_MIN) s.pow = true;
    }
    return steps;
}

function groupByTarget(records) {
    const groups = new Map(); // target -> ordered records
    for (const r of records) {
        const t = r.target || '<unknown target>';
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(r);
    }
    return groups;
}

function renderRecipe(target, steps) {
    const lines = [];
    const total = steps.reduce((a, s) => a + (s.count || 1), 0);
    lines.push(`=== ${target} — ${total} crypto call(s), ${steps.length} step(s) ===`);
    steps.forEach((s, i) => {
        const count = (s.count || 1) > 1 ? ` x${s.count}` : '';
        const loc = s.loc ? `  ${C.dim}${s.loc}${C.reset}` : '';
        const pow = s.pow ? `  ${C.hlyel}<-- proof-of-work style burst${C.reset}` : '';
        lines.push(` ${String(i + 1).padStart(2)}. ${s.method}${count}  ${C.cyan}${s.caller}${C.reset}${loc}${pow}`);
        if (s.args !== null && s.args !== undefined) {
            let a;
            try { a = JSON.stringify(s.args); } catch (e) { a = String(s.args); }
            lines.push(`      ${C.dim}args ${a.substring(0, 220)}${C.reset}`);
        }
    });
    return lines.join('\n');
}

// ANSI helpers (kept tiny - no dependency on src/ so the script also runs
// standalone against logs copied off a machine without the repo).
const C = {
    reset: '\x1b[0m', dim: '\x1b[90m', cyan: '\x1b[36m',
    hlyel: '\x1b[43m\x1b[30m'
};

function findLatestLog() {
    const candidates = fs.readdirSync('.').filter(f => /^session_capture_\d+\.jsonl$/.test(f));
    if (!candidates.length) return null;
    return candidates.sort().pop();
}

function main() {
    const argv = process.argv.slice(2);
    const jsonOut = argv.includes('--json');
    const args = argv.filter(a => a !== '--json');
    const logPath = args[0] || findLatestLog();
    if (!logPath) {
        console.error('No session_capture_*.jsonl given and none found in cwd.');
        process.exit(2);
    }
    let records;
    try {
        records = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean)
            .filter(e => e.type === 'crypto_call');
    } catch (e) {
        console.error('cannot read ' + logPath + ': ' + e.message);
        process.exit(2);
    }

    if (!records.length) {
        console.log(`No crypto_call records in ${logPath}.`);
        console.log('(crypto_call records come from the CDP breakpoints; the page-side');
        console.log(' wrapper events are logged separately as hook_event lines.)');
        process.exit(0);
    }

    const groups = groupByTarget(records);
    if (jsonOut) {
        const out = {};
        for (const [target, recs] of groups) out[target] = buildRecipe(recs);
        console.log(JSON.stringify(out, null, 2));
        return;
    }
    console.log(`crypto-recipe: ${records.length} crypto call(s) across ${groups.size} target(s) from ${logPath}\n`);
    for (const [target, recs] of groups) {
        console.log(renderRecipe(target, buildRecipe(recs)));
        console.log('');
    }
}

if (require.main === module) main();

module.exports = { buildRecipe, groupByTarget, renderRecipe };
