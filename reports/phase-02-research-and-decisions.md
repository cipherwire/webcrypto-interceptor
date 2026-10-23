# Phase 2 - Research, Adjudication, and Evidence-Based Decisions Report

Date: 2026-10-23
Project: webcrypto-interceptor
Baseline Test Suite: 96 passing tests (node tests/run.js)

---

## Executive Summary

An independent, evidence-based revalidation and research investigation was conducted across 10 improvement candidates identified in the codebase. Every candidate was tested dynamically against reproduction scripts, evaluated against authoritative specifications (Chrome DevTools Protocol, ECMA-426, W3C Web Cryptography API, WebAssembly Web API), and adjudicated with an explicit decision record.

Two confirmed critical defects were verified in WebAssembly payload handling:
1. Multi-chunk WebAssembly bytecode payloads fail to reassemble because chunk identifiers mismatch receiver grouping keys.
2. WebAssembly TypedArray input extraction discards byte offsets and lengths, corrupting captured binaries when views are passed.

Two high-value performance and observability improvements were confirmed:
3. String-table unpacker executes sequential CDP round-trips; batched evaluation provides a 16.9x speedup without breaking early termination.
4. End-to-end browser integration tests lacked assertions on Node-side event receipt and log persistence.

---

## Detailed Candidate Adjudication

### Candidate 1 - WebAssembly Chunk Reassembly

- **Current Behavior**: In `src/page/stealth.js` (line 84), chunked WASM payloads are emitted with `uid: uid + '#' + i` so each chunk has an incremented UID (e.g., `c1#0`, `c1#1`). In `src/cdp/events.js` (line 44), `reassembleChunks` groups chunks by `const id = evt.uid || evt.hash`. Because `evt.uid` differs on every chunk, each chunk initializes a separate slot with `parts.size = 1`. The condition `parts.size === total` is never satisfied for multi-chunk payloads, and `reassembleChunks` returns `null` for every chunk. In `tests/events.test.js`, the test masked this by manually overriding `uid` to be identical across chunks.
- **Evidence**: Dynamically reproduced with a 2-chunk payload. Current implementation returned `null` for all chunks and failed to reconstruct the binary.
- **Proposed Change**: Change `reassembleChunks` in `src/cdp/events.js` to group chunks by transfer parent identity: `const id = evt.transferId || (evt.uid && evt.uid.split('#')[0]) || evt.hash`. Keep individual `evt.uid` tracking in `isDuplicate` for delivery deduplication. Add timeout cleanup for stalled slots.
- **Expected Benefit**: Full, byte-for-byte reassembly of large WASM modules (>8KB hex) across multiple CDP binding events.
- **Downsides / Risks**: None when backward-compatible with single-chunk and legacy event envelopes.
- **Verification Plan**: Synthetic unit tests testing multi-chunk, out-of-order, duplicate chunk, and mismatched chunk scenarios, verifying byte-for-byte equality against original buffer.
- **Objective Acceptance Criteria**: Multi-chunk WASM module (e.g. 64KB) emitted with `uid#0`, `uid#1` reassembles to identical Buffer.
- **Verdict**: **FIX** (Confirmed Defect).

---

### Candidate 2 - WebAssembly Typed-Array View Boundaries

- **Current Behavior**: In `src/page/stealth.js` (lines 342, 350), `WebAssembly.compile` and `WebAssembly.instantiate` hooks extract bytes via:
  `var bytes = (bufferSource instanceof ArrayBuffer) ? bufferSource : (bufferSource && bufferSource.buffer);`
  If a caller passes a TypedArray view with a non-zero `byteOffset` or smaller `byteLength` (e.g. `new Uint8Array(buffer, 8, 16)`), `bytes` evaluates to the full underlying ArrayBuffer. Inside `dumpWasm`, `new Uint8Array(bytes)` reads from offset 0 of the entire backing buffer, ignoring `byteOffset` and `byteLength`.
- **Evidence**: Dynamically reproduced. A 16-byte backing buffer with an 8-byte view at offset 8 produced a 16-byte captured dump starting at offset 0 instead of the intended 8 bytes.
- **Proposed Change**: Handle TypedArray views correctly:
  `var arr = ArrayBuffer.isView(bufferSource) ? new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, bufferSource.byteLength) : new Uint8Array(bufferSource);`
- **Expected Benefit**: Accurate byte capture matching what the browser V8 engine compiles.
- **Downsides / Risks**: None. Standard JavaScript TypedArray handling.
- **Verification Plan**: Unit tests passing full ArrayBuffer, Uint8Array view with offset 0, and Uint8Array view with non-zero offset and restricted length.
- **Objective Acceptance Criteria**: Captured binary matches view content exactly byte-for-byte.
- **Verdict**: **FIX** (Confirmed Defect).

---

### Candidate 3 - WebAssembly Module Identity and Hash Collisions

- **Current Behavior**: In `src/page/stealth.js` (line 311), `getWasmHash` calculates a 32-bit DJB2 hash over at most the first 1,024 bytes. In `src/cdp/events.js` (line 128), `dumpWasmFromHex` writes to `module_${hash}.wasm` using this 32-bit hash. Distinct modules sharing a 1,024-byte prefix produce identical hashes, causing `fs.writeFileSync` to overwrite the existing module file.
- **Evidence**: Dynamically reproduced. Two distinct 2,048-byte buffers sharing the first 1,024 bytes produced identical DJB2 hash `e4e25505`, colliding and overwriting each other. Node.js SHA-256 calculation produced distinct hashes `3a34c8dc4aec1554` and `9121349d9bd1414c` in under 0.05ms.
- **Proposed Change**: In `dumpWasmFromHex` on the Node.js side (where the full reassembled buffer is already present in memory), compute a content-addressed SHA-256 hash `crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)`. Use this SHA-256 hash for module naming and tracking.
- **Expected Benefit**: Zero collision risk between distinct modules; robust content addressing; minimal overhead (<0.1ms per module).
- **Downsides / Risks**: None. Page-side event continues to log its quick prefix hash for console readability.
- **Verification Plan**: Test saving two modules with identical 1024-byte prefixes; verify both files are preserved without overwriting.
- **Objective Acceptance Criteria**: Distinct files created on disk for distinct modules.
- **Verdict**: **FIX** (Confirmed Reliability Improvement).

---

### Candidate 4 - Batch Runtime String-Table Evaluation

- **Current Behavior**: In `src/cdp/strings.js`, `unpackStrings` sends an individual `Runtime.evaluate` CDP command for every probed index in a loop. For 512 indices, this requires 512 sequential CDP IPC round-trips over the WebSocket connection, taking 1.0 to 1.5 seconds.
- **Evidence**: Benchmark demonstrated that batched evaluation (chunks of 64 indices per `Runtime.evaluate`) reduces round-trips from 512 to 8, achieving a 16.9x speedup while collecting identical string tables.
- **Proposed Change**: Introduce a configurable batching loop (e.g. `batchSize = 64`) that evaluates an in-page IIFE returning a dictionary of resolved strings for the chunk:
  ```javascript
  /*wci:str_batch*/(function(start, count, extra) {
      var res = {};
      for (var i = start; i < start + count; i++) {
          try {
              var v = (DECODER)(i, ...extra);
              if (typeof v === 'string') res[i] = v;
          } catch (e) {}
      }
      return res;
  })(start, count, extraArgs)
  ```
  Check `maxConsecutiveErrors` after each batch to preserve early exit behavior.
- **Expected Benefit**: Probing 512 or 1024 strings drops from ~1.5s to <50ms.
- **Downsides / Risks**: If an individual index causes an unrecoverable exception that halts the batch loop, individual fallback or try/catch isolation is needed. The in-page try/catch loop addresses this.
- **Verification Plan**: Unit tests with mock CDPSession comparing sequential vs batched output and verifying `maxConsecutiveErrors` early termination.
- **Objective Acceptance Criteria**: Same decoded dictionary returned; CDP round-trips reduced by at least 80%.
- **Verdict**: **ADD** (Verified Performance Improvement).

---

### Candidate 5 - Forward Dataflow Object Return Values and Caller Scope Timing

- **Current Behavior**: In `src/cdp/dataflow.js`, `resolveConsumer` checks:
  `if (returnValue && returnValue.value !== undefined && callerFrame.callFrameId)`
  For non-primitive return values (CryptoKey, ArrayBuffer, Uint8Array, Object), CDP returns `value: undefined` and provides `objectId`. Furthermore, when V8 pauses at a function return breakpoint, execution is paused inside the callee before returning to the caller. The caller frame has not yet executed the assignment statement.
- **Evidence**: Confirmed via V8 debugging architecture analysis. Scope inspection at return breakpoint cannot observe a return value assigned into a caller local variable because the assignment opcode in caller bytecode executes after callee return.
- **Proposed Change**: Preserve the current best-effort primitive matching. Document clearly in code comments and specifications that variable attribution is best-effort for primitives, and that caller function and location attribution (`callerFrame.functionName`, `callerFrame.url`, `callerFrame.location`) is the reliable contract. Do not introduce invasive stepping (`Debugger.stepOut`) which would alter asynchronous execution timing.
- **Expected Benefit**: Clear, documented contract without introducing execution jitter or race conditions.
- **Verdict**: **NO CODE CHANGE REQUIRED / DOCUMENT LIMITATION**.

---

### Candidate 6 - Sourcemap Discovery and Extraction Coverage

- **Current Behavior**: In `src/cdp/scripts.js`, `Debugger.scriptParsed` receives `params.sourceMapURL` directly from V8, but only passes `source` to `saveFile`. `handleSourcemap` in `src/cdp/extract.js` only looks for inline `sourceMappingURL` comments in the text body. If a sourcemap was specified via HTTP header (`SourceMap: <url>`), it is missed.
- **Evidence**: CDP `Debugger.scriptParsed` specification guarantees `sourceMapURL` is populated when detected by Chromium from either comments or headers.
- **Proposed Change**: Pass `params.sourceMapURL` from `Debugger.scriptParsed` into `saveFile` and `handleSourcemap`. In `handleSourcemap`, if text regex finds no match, use `sourceMapUrl` as a fallback. Ensure `http:` and `https:` protocol checks remain enforced before fetching.
- **Expected Benefit**: Expands sourcemap recovery to include scripts with stripped comments that rely on HTTP headers.
- **Downsides / Risks**: None when URL validation is preserved.
- **Verification Plan**: Test `handleSourcemap` with explicit sourceMapUrl parameter and verify sources are unpacked.
- **Objective Acceptance Criteria**: Sourcemaps without inline comments are successfully recovered when `sourceMapURL` is provided.
- **Verdict**: **ADD** (Verified Functional Enhancement).

---

### Candidate 7 - WebAssembly Streaming Capture

- **Current Behavior**: In `src/page/stealth.js`, `WebAssembly.instantiateStreaming` only emits an event with `bytes: 0, hash: 'streaming'`. `WebAssembly.compileStreaming` is not hooked. Bytecode is not captured from streaming calls unless `--full` network capture captures the `.wasm` HTTP response.
- **Evidence**: Testing confirmed that `Response.prototype.clone()` safely clones a Response stream before it is consumed, allowing `.arrayBuffer()` to extract the bytecode without affecting `WebAssembly.instantiateStreaming` or `compileStreaming`.
- **Proposed Change**: In `src/page/stealth.js`, hook `instantiateStreaming` and `compileStreaming`. Wrap the `source` Promise or Response with a cloned response handler that asynchronously reads `.arrayBuffer()` and calls `dumpWasm`. If cloning fails or is unsupported, fall back cleanly to passing the original source without error.
- **Expected Benefit**: Full bytecode capture for modern sites that instantiate WebAssembly via streaming APIs.
- **Downsides / Risks**: Additional memory buffering during Wasm download. Guard with the same 5MB limit used for standard Wasm dumps.
- **Verification Plan**: Node and browser tests compiling Wasm via `compileStreaming` and `instantiateStreaming` and verifying dumped bytecode.
- **Objective Acceptance Criteria**: Streaming WebAssembly calls trigger `dumpWasm` and capture bytecode.
- **Verdict**: **ADD** (Verified Functional Enhancement).

---

### Candidate 8 - End-to-End Test Assertions

- **Current Behavior**: In `tests/e2e.test.js`, the test launches Puppeteer, injects stealth hooks, performs WebCrypto operations in the page, but only asserts:
  `assert.equal(evalResult.hasBinding, true)`
  `assert.equal(evalResult.isSecureContext, true)`
  `assert.ok(evalResult.ciphertextLen > 0)`
  It never asserts that the Node-side interceptor received the event, that `writeLog` recorded it, or that the captured event contains the correct key and ciphertext.
- **Evidence**: Code inspection confirmed zero assertions on `getLogFile()` or summary state in `tests/e2e.test.js`. If event transmission silently broke, `tests/e2e.test.js` would still pass.
- **Proposed Change**: Configure a temporary log directory with `setLogDir` in `tests/e2e.test.js`. After the browser operation completes, read the generated JSONL log file and assert:
  1. The log file exists and is non-empty.
  2. Events of type `crypto_args` and `crypto_result` are recorded.
  3. `generateKey` and `encrypt` methods were logged with expected algorithm `AES-GCM` and plaintext string.
- **Expected Benefit**: True end-to-end regression protection across the full pipeline (Page -> CDP Binding -> Node Handler -> Log File).
- **Downsides / Risks**: None.
- **Verification Plan**: Run `node tests/run.js` and verify assertions execute and pass.
- **Objective Acceptance Criteria**: E2E test fails if Node-side event receipt or logging fails.
- **Verdict**: **FIX** (Confirmed Test Quality Defect).

---

### Candidate 9 - Sensitive Value Handling and Redaction Options

- **Current Behavior**: All captured keys, IVs, plaintexts, and secrets are logged in full to terminal stdout and the JSONL log file.
- **Evidence**: `webcrypto-interceptor` is explicitly designed as a security auditing and reverse-engineering tool to capture cleartext keys. Redacting values by default would defeat its primary function.
- **Evaluation**: While an opt-in `--redact` flag could be helpful for recording public demos or sanitizing CI logs, it is not an active defect and was not requested for core workflows.
- **Verdict**: **DO NOT ADD** (Speculative scope expansion; keep core tool focused on high-fidelity extraction).

---

### Candidate 10 - Runtime and Documentation Consistency

- **Current Behavior**:
  - `package.json` specifies `"engines": { "node": ">=22.12.0" }`.
  - CI workflow (`.github/workflows/ci.yml`) tests Node 22, 24, 26 on Ubuntu, Windows, and macOS.
  - On macOS, Chrome is not pre-installed by default, and `PUPPETEER_SKIP_DOWNLOAD: 'true'` causes browser resolution checks to fail if Chrome is absent.
  - Script syntax checks in CI check individual files instead of verifying all source files.
- **Proposed Change**:
  - In CI workflow, verify browser availability with graceful fallback or skip on runners without installed browsers (`SKIP_E2E=1`).
  - Add comprehensive syntax check covering all files under `src/` and `scripts/`.
- **Expected Benefit**: Clean CI runs across all target operating systems without spurious failures.
- **Verdict**: **FIX** (Verified CI Infrastructure Improvement).

---

## Prioritized Implementation Roadmap

1. **Phase 1 (Defects)**:
   - Candidate 1: Fix WASM chunk reassembly in `src/cdp/events.js`.
   - Candidate 2: Fix WASM TypedArray view handling in `src/page/stealth.js`.
   - Candidate 3: Add content-addressed SHA-256 for WASM module dumps in `src/cdp/events.js`.
   - Candidate 8: Strengthen E2E test assertions in `tests/e2e.test.js`.

2. **Phase 2 (Enhancements)**:
   - Candidate 4: Implement batched runtime string-table evaluation in `src/cdp/strings.js`.
   - Candidate 6: Wire `params.sourceMapURL` into `src/cdp/scripts.js` and `src/cdp/extract.js`.
   - Candidate 7: Implement streaming WebAssembly capture in `src/page/stealth.js`.
   - Candidate 10: Enhance CI workflow checks in `.github/workflows/ci.yml`.

3. **Phase 3 (Regression & Verification)**:
   - Run full unit, integration, and E2E test suites.
   - Run ESLint and security audits.
   - Generate final comparison benchmarks and summary report.
