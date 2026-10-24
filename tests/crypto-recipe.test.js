'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecipe, groupByTarget, renderRecipe } = require('../scripts/crypto-recipe');

const rec = (method, caller, target, extra) => Object.assign({
    type: 'crypto_call',
    method: 'crypto.subtle.' + method,
    caller,
    target,
    stack: [{ fn: caller, url: 'https://cdn.example/assets/pow.js', line: 40, col: 613 }],
    timestamp: '2026-10-24T14:00:00.000Z'
}, extra || {});

test('buildRecipe merges consecutive identical (method, caller) runs', () => {
    const steps = buildRecipe([
        rec('exportKey', 'Wn', 't'),
        rec('exportKey', 'Wn', 't'),
        rec('sign', 'ar', 't')
    ]);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].method, 'exportKey');
    assert.equal(steps[0].count, 2);
    assert.equal(steps[1].method, 'sign');
    assert.equal(steps[1].count, 1);
});

test('buildRecipe flags proof-of-work style digest bursts', () => {
    const steps = buildRecipe([
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't'),
        rec('decrypt', 'La', 't')
    ]);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].count, 4);
    assert.equal(steps[0].pow, true, '4 consecutive digests = PoW burst');
    assert.equal(steps[1].pow, false);
});

test('buildRecipe keeps first-seen args when a run has none on the first hit', () => {
    const steps = buildRecipe([
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't', { args: [{ __t: 'Uint8Array', len: 32, hex: 'ab'.repeat(32) }] })
    ]);
    assert.equal(steps.length, 1);
    assert.ok(steps[0].args, 'args from later hits are folded into the merged step');
});

test('buildRecipe keeps distinct callers as separate steps even for same method', () => {
    const steps = buildRecipe([
        rec('digest', 'Yn', 't'),
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't')
    ]);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].caller, 'Yn');
    assert.equal(steps[1].caller, 'qe');
    assert.equal(steps[1].count, 2);
});

test('groupByTarget preserves first-seen target order and separates contexts', () => {
    const groups = groupByTarget([
        rec('generateKey', 'Wn', 'other:n1mwq.org/t8p/x'),
        rec('generateKey', 'Wn', 'main:piratexplay.cc/'),
        rec('sign', 'ar', 'other:n1mwq.org/t8p/x')
    ]);
    assert.deepEqual([...groups.keys()], ['other:n1mwq.org/t8p/x', 'main:piratexplay.cc/']);
    assert.equal(groups.get('other:n1mwq.org/t8p/x').length, 2);
});

test('renderRecipe prints args and PoW markers', () => {
    const out = renderRecipe('t', buildRecipe([
        rec('importKey', 'La', 't', { args: [{ format: 'raw', __t: 'Uint8Array', len: 32, hex: 'aa'.repeat(32) }] }),
        rec('decrypt', 'La', 't', { args: [{ name: 'AES-GCM', iv: { __t: 'Uint8Array', len: 12, hex: 'bb'.repeat(12) } }] })
    ]));
    assert.ok(out.includes('=== t'));
    assert.ok(out.includes('importKey'));
    assert.ok(out.includes('args'), 'args line present');
    assert.ok(out.includes('AES-GCM'), 'algorithm from args visible');
    assert.ok(!out.includes('proof-of-work'), 'no PoW flag for non-burst steps');
});

test('renderRecipe collapses a PoW burst with the marker', () => {
    const out = renderRecipe('t', buildRecipe([
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't'),
        rec('digest', 'qe', 't')
    ]));
    assert.ok(out.includes('digest x5'));
    assert.ok(out.includes('proof-of-work'));
});
