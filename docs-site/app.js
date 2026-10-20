/* global document, navigator, window */

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initCopyButtons();
    initSimulator();
    initSearch();
});

// 1. Tab Navigation
function initTabs() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const panes = document.querySelectorAll('.tab-pane');

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-tab');

            navButtons.forEach(b => b.classList.remove('active'));
            panes.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const targetPane = document.getElementById(targetId);
            if (targetPane) {
                targetPane.classList.add('active');
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    });
}

// 2. Copy Code Snippets
function initCopyButtons() {
    document.querySelectorAll('.code-copy-btn, .quick-clone-copy').forEach(btn => {
        btn.addEventListener('click', () => {
            let textToCopy = '';
            if (btn.classList.contains('quick-clone-copy')) {
                const code = document.querySelector('.quick-clone-cmd code');
                textToCopy = code ? code.textContent.trim() : '';
            } else {
                const box = btn.closest('.code-box');
                const code = box ? box.querySelector('code') : null;
                textToCopy = code ? code.innerText.trim() : '';
            }

            if (!textToCopy) return;

            navigator.clipboard.writeText(textToCopy).then(() => {
                const orig = btn.textContent;
                btn.textContent = 'copied';
                btn.style.borderColor = 'var(--terminal-green)';
                btn.style.color = 'var(--terminal-green)';
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.style.borderColor = '';
                    btn.style.color = '';
                }, 1500);
            });
        });
    });
}

// 3. Search Filter
function initSearch() {
    const searchInput = document.getElementById('search-input');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        const items = document.querySelectorAll('.nav-item');

        items.forEach(item => {
            const btn = item.querySelector('.nav-btn');
            const text = btn ? btn.textContent.toLowerCase() : '';
            item.style.display = (!query || text.includes(query)) ? 'block' : 'none';
        });
    });
}

// 4. Interactive Live CDP Stream Simulator
const SIM_SCENARIOS = {
    webcrypto: [
        { time: '00:00.102', tag: '[ATTACH]', color: 'term-dim', text: 'Puppeteer connected via anonymous pipe (pipe: true)' },
        { time: '00:00.124', tag: '[V8 TRAP]', color: 'term-blue', text: 'Debugger.setBreakpointOnFunctionCall armed on crypto.subtle' },
        { time: '00:00.148', tag: '[CRYPTO ARGS]', color: 'term-green', text: 'generateKey [{"name":"AES-GCM","length":256},true,["encrypt","decrypt"]]' },
        { time: '00:00.155', tag: '[CRYPTO RESULT]', color: 'term-green', text: 'generateKey -> {"__t":"CryptoKey","type":"secret","length":256,"extractable":true}' },
        { time: '00:00.170', tag: '[RANDOM NONCE]', color: 'term-amber', text: 'getRandomValues Uint8Array len=12 hex=7b5a8087d11808f85ff549a7' },
        { time: '00:00.185', tag: '[CRYPTO ARGS]', color: 'term-green', text: 'encrypt [{"name":"AES-GCM","iv":{"hex":"7b5a8087d11808f85ff549a7"}},"Key",{"utf8":"E2E Cleartext Message"}]' },
        { time: '00:00.192', tag: '[CRYPTO RESULT]', color: 'term-green', text: 'encrypt -> {"__t":"ArrayBuffer","len":38,"hex":"855e4fc230a5aa9a03843260fb8d58ca02dd"}' },
        { time: '00:00.205', tag: '[IPC RELAY]', color: 'term-dim', text: '__wci event envelope flushed to session_capture_1730000000.jsonl' }
    ],
    drm: [
        { time: '00:01.012', tag: '[HLS MANIFEST]', color: 'term-blue', text: 'Fetched master playlist https://webcryptotest.hainahola.store/stream/manifest.m3u8' },
        { time: '00:01.025', tag: '[KEY DETECTED]', color: 'term-amber', text: '#EXT-X-KEY:METHOD=AES-128,URI="stream/enc.key",IV=0x53656372657449563030313132323333' },
        { time: '00:01.040', tag: '[WORKER SPAWN]', color: 'term-dim', text: 'Target.attachedToTarget dedicated worker (hls.worker.js)' },
        { time: '00:01.082', tag: '[KEY IMPORTED]', color: 'term-green', text: 'crypto.subtle.importKey raw key=41424344454630313233343536373839 (16 bytes)' },
        { time: '00:01.120', tag: '[CHUNK DECRYPT]', color: 'term-green', text: 'crypto.subtle.decrypt segment_0.ts (len=1,888 bytes) with key=41424344...' },
        { time: '00:01.135', tag: '[CORRELATION]', color: 'term-white', text: 'Correlated segment_0.ts with key=41424344... iv=53656372657449563030313132323333' },
        { time: '00:01.140', tag: '[DISK FILTER]', color: 'term-dim', text: 'Skipped raw 5MB MPEG-TS payload write to disk (--full media filter active)' }
    ],
    wasm: [
        { time: '00:00.410', tag: '[WASM COMPILE]', color: 'term-blue', text: 'WebAssembly.compile called with 14,280 bytes of binary bytecode' },
        { time: '00:00.415', tag: '[MAGIC VERIFY]', color: 'term-dim', text: 'Header verification: \\0asm version 1 (valid WebAssembly binary)' },
        { time: '00:00.422', tag: '[IPC CHUNKING]', color: 'term-amber', text: 'Bytecode split into 32KB hex packets (seq 1 of 1, hash=d41d8cd98f00b204e9800998ecf8427e)' },
        { time: '00:00.430', tag: '[WASM DUMPED]', color: 'term-green', text: 'Reconstructed binary saved to wasm_modules/module_d41d8cd9.wasm' },
        { time: '00:00.445', tag: '[EXPORT HOOK]', color: 'term-green', text: 'Exported methods wrapped: ["encryptBlock", "deriveSecret", "memory"]' },
        { time: '00:00.510', tag: '[EXPORT CALL]', color: 'term-white', text: 'encryptBlock(ptr=1024, len=16) -> ret=1' }
    ],
    oracle: [
        { time: '00:00.010', tag: '[ORACLE INIT]', color: 'term-dim', text: 'Loading recorded session session_capture_1730000000.jsonl' },
        { time: '00:00.024', tag: '[VECTORS LOADED]', color: 'term-blue', text: 'Parsed 8 test vectors for hooked label "window.signPayload"' },
        { time: '00:00.035', tag: '[SANDBOX START]', color: 'term-dim', text: 'Spawning isolated page (about:blank, network disabled)' },
        { time: '00:00.048', tag: '[VECTOR 1/8]', color: 'term-green', text: 'input: ["user_102", "nonce_99"] -> candidate matched ground truth (0.8ms)' },
        { time: '00:00.052', tag: '[VECTOR 2/8]', color: 'term-green', text: 'input: ["user_103", "nonce_100"] -> candidate matched ground truth (0.7ms)' },
        { time: '00:00.070', tag: '[VECTOR 8/8]', color: 'term-green', text: 'input: ["user_110", "nonce_107"] -> candidate matched ground truth (0.6ms)' },
        { time: '00:00.075', tag: '[VERDICT]', color: 'term-green', text: 'VERIFIED: reimplementation matches ground truth across all 8 vectors' }
    ],
    dataflow: [
        { time: '00:00.080', tag: '[HOOK ARMED]', color: 'term-blue', text: 'Debugger.setBreakpointOnFunctionCall armed on window.signPayload' },
        { time: '00:00.110', tag: '[PRODUCER HIT]', color: 'term-amber', text: 'signPayload(["challenge_nonce_01"]) entered' },
        { time: '00:00.125', tag: '[RETURN BP]', color: 'term-dim', text: 'Debugger.getPossibleBreakpoints armed on return locations' },
        { time: '00:00.138', tag: '[RETURN CAPTURE]', color: 'term-green', text: 'signPayload -> returned "sig_948fbc21a08e"' },
        { time: '00:00.145', tag: '[CALLER RESOLVE]', color: 'term-dim', text: 'Inspecting caller frame frames[1]: dispatchAuthHeader at api.js:84' },
        { time: '00:00.152', tag: '[SCOPE SCAN]', color: 'term-blue', text: 'Scanning caller local/closure scope for "sig_948fbc21a08e"' },
        { time: '00:00.160', tag: '[DATAFLOW]', color: 'term-green', text: 'window.signPayload -> consumed by dispatchAuthHeader at api.js:84 (received by authToken)' }
    ],
    strings: [
        { time: '00:00.210', tag: '[UNPACK INIT]', color: 'term-dim', text: 'Probing live string decoder _0x4b12 across index ranges' },
        { time: '00:00.225', tag: '[DECODER HIT]', color: 'term-blue', text: 'Runtime.evaluate: _0x4b12(0) -> "Bearer sec_k8s_cluster_8841a0e9124fb87ac339"' },
        { time: '00:00.235', tag: '[DECODER HIT]', color: 'term-blue', text: 'Runtime.evaluate: _0x4b12(1) -> "AKIAIOSFODNN7REALEXMPL"' },
        { time: '00:00.245', tag: '[DECODER HIT]', color: 'term-blue', text: 'Runtime.evaluate: _0x4b12(2) -> "arn:aws:kms:us-east-1:123456789012:key/b6f5d840..."' },
        { time: '00:00.260', tag: '[PROBE MISS]', color: 'term-amber', text: 'Runtime.evaluate: _0x4b12(15..47) threw consecutive out-of-range exceptions' },
        { time: '00:00.275', tag: '[STRINGS DUMPED]', color: 'term-green', text: 'Recovered 15 strings from runtime-rotated table into strings_1730000000.json' }
    ],
    vm: [
        { time: '00:00.310', tag: '[VM ARMED]', color: 'term-blue', text: 'Debugger.setBreakpointByUrl armed at vm_core.js:142' },
        { time: '00:00.325', tag: '[VM #1]', color: 'term-green', text: 'vm_core.js:142 pc=0 opcode="PUSH_CONST" stack[sp]="init"' },
        { time: '00:00.332', tag: '[VM #2]', color: 'term-green', text: 'vm_core.js:142 pc=1 opcode="LOAD_REG" stack[sp]=1024' },
        { time: '00:00.340', tag: '[VM #3]', color: 'term-green', text: 'vm_core.js:142 pc=2 opcode="XOR_KEY" stack[sp]=0x5f' },
        { time: '00:00.348', tag: '[VM #4]', color: 'term-green', text: 'vm_core.js:142 pc=3 opcode="STORE_MEM" stack[sp]=0' },
        { time: '00:00.355', tag: '[VM TRACE]', color: 'term-dim', text: 'Flushed 4 VM execution cycles to session log' }
    ]
};

function initSimulator() {
    const screen = document.getElementById('sim-screen');
    const buttons = document.querySelectorAll('.sim-btn');
    if (!screen || !buttons.length) return;

    function runScenario(key) {
        screen.innerHTML = '';
        buttons.forEach(b => b.classList.toggle('active', b.getAttribute('data-sim') === key));

        const events = SIM_SCENARIOS[key] || [];
        events.forEach((ev, idx) => {
            setTimeout(() => {
                const line = document.createElement('div');
                line.className = 'sim-line';
                line.innerHTML = `<span class="term-dim">[${ev.time}]</span> <span class="${ev.color}">${ev.tag}</span> ${escapeHtml(ev.text)}`;
                screen.appendChild(line);
                screen.scrollTop = screen.scrollHeight;
            }, idx * 120);
        });
    }

    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-sim');
            runScenario(key);
        });
    });

    // Run first scenario by default
    runScenario('webcrypto');
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
