/**
 * CIPHERGATE Production Cryptographic Engine & Verification Target
 * Implements real-world W3C WebCrypto, RFC 7519 JWT signatures,
 * WebAssembly binary kernels, HLS DRM ClearKey encryption, and V8 heap mechanics.
 */

let eventCounter = 0;
const termBody = document.getElementById('termBody');
const counterEl = document.getElementById('eventCounter');

function logEvent(tag, tagClass, title, payload) {
  eventCounter++;
  if (counterEl) counterEl.textContent = eventCounter;
  
  if (!termBody) return;
  const line = document.createElement('div');
  line.className = 'term-line';
  
  const time = new Date().toISOString().substring(11, 23);
  line.innerHTML = `
    <div class="term-line-header">
      <span>${time}</span>
      <span class="term-tag ${tagClass}">[${tag}]</span>
      <strong>${title}</strong>
    </div>
    <div class="term-payload">${escapeHtml(payload)}</div>
  `;
  termBody.prepend(line);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bufToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function strToBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function arrayBufferToPem(buffer, label) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

// =========================================================================
// 1. Obfuscated Runtime-Rotated Secret Table (_0x4b12)
// Realistic enterprise secrets, connection strings, and KMS endpoints
// =========================================================================
const _0x3e19 = [
  'postgresql://vault_admin:p4ss_99b74011fa92305@db-primary.internal:5432/kms_vault',
  'Bearer sec_k8s_cluster_8841a0e9124fb87ac339',
  'AKIAIOSFODNN7REALEXMPL',
  'arn:aws:kms:us-east-1:123456789012:key/b6f5d840-81f1-4b19-b570-381c81ef40d2',
  'https://license.drm.cipherwire.link/widevine/cenc',
  'X-Authorization-HMAC-SHA256',
  'application/vnd.apple.mpegurl',
  'AES-GCM-256',
  'ECDSA-P256-SHA256',
  'RSA-OAEP-2048-SHA256',
  'Content-Type',
  'application/json',
  'https://api.cipherwire.link/v2/vault/keys/master/export',
  'client_secret_live_7719ab4280f991c0e5a8',
  'b9f4a8120c4e7d3a5e1289c03b145a6d'
];

// Runtime shuffle IIFE: rotates array positions on script load
(function(arr, count) {
  const rot = function(c) {
    while (--c) {
      arr.push(arr.shift());
    }
  };
  rot(++count);
})(_0x3e19, 0x1f);

// Live decoder function exposed on window for --dump-strings "_0x4b12"
window._0x4b12 = function(idx) {
  idx = idx - 0;
  const val = _0x3e19[idx];
  if (!val) throw new Error('Out of bounds index: ' + idx);
  return val;
};

// =========================================================================
// 2. Real WebCrypto Subtle AES-GCM-256 Operations
// =========================================================================
window.runAesGcm = async function() {
  try {
    // Generate real cryptographically secure AES-GCM 256-bit key in BoringSSL
    const key = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Cryptographically secure 96-bit Initialization Vector
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const rawKey = await window.crypto.subtle.exportKey('raw', key);
    const keyHex = bufToHex(rawKey);
    const ivHex = bufToHex(iv);

    const sensitivePayload = JSON.stringify({
      account: 'ACC-8849-0192',
      balance: 142500.50,
      currency: 'USD',
      transferTo: 'ACC-1102-9934',
      timestamp: Date.now()
    });

    const plaintext = new TextEncoder().encode(sensitivePayload);
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    const ctHex = bufToHex(ciphertext);

    // Decrypt to verify roundtrip and trigger subtle.decrypt interception
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    const recoveredText = new TextDecoder().decode(decrypted);

    document.getElementById('gcmKeyHex').textContent = keyHex;
    document.getElementById('gcmIvHex').textContent = ivHex;
    document.getElementById('gcmCtHex').textContent = ctHex.substring(0, 48) + '... (' + ciphertext.byteLength + ' bytes)';

    logEvent('CRYPTO', 'term-tag-crypto', 'subtle.encrypt [AES-GCM-256]', `Key=${keyHex.substring(0, 16)}... IV=${ivHex} CT=${ctHex.substring(0, 32)}... Plaintext="${recoveredText}"`);
  } catch (err) {
    console.error('AES-GCM failed:', err);
  }
};

// =========================================================================
// 3. Real WebCrypto Subtle RSA-OAEP 2048-bit Key Generation & Encryption
// =========================================================================
window.runRsaOaep = async function() {
  try {
    // Generate real 2048-bit RSA-OAEP keypair
    const rsaKeypair = await window.crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256'
      },
      true,
      ['encrypt', 'decrypt']
    );

    // Export public key as SPKI and format as standard PEM
    const spkiDer = await window.crypto.subtle.exportKey('spki', rsaKeypair.publicKey);
    const spkiPem = arrayBufferToPem(spkiDer, 'PUBLIC KEY');

    // Export private key as PKCS#8 and format as standard PEM
    const pkcs8Der = await window.crypto.subtle.exportKey('pkcs8', rsaKeypair.privateKey);
    const pkcs8Pem = arrayBufferToPem(pkcs8Der, 'PRIVATE KEY');

    // Encrypt a 256-bit symmetric session key with RSA-OAEP
    const sessionKeyBytes = window.crypto.getRandomValues(new Uint8Array(32));
    const encryptedKey = await window.crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      rsaKeypair.publicKey,
      sessionKeyBytes
    );

    // Decrypt back to verify
    const decryptedKeyBytes = await window.crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      rsaKeypair.privateKey,
      encryptedKey
    );

    const encKeyHex = bufToHex(encryptedKey);
    const decKeyHex = bufToHex(decryptedKeyBytes);

    document.getElementById('rsaPubPem').textContent = spkiPem.split('\n').slice(0, 4).join('\n') + '\n...';
    document.getElementById('rsaPrivPem').textContent = pkcs8Pem.split('\n').slice(0, 4).join('\n') + '\n...';
    document.getElementById('rsaCtHex').textContent = encKeyHex.substring(0, 48) + '... (256 bytes RSA envelope)';

    logEvent('CRYPTO', 'term-tag-crypto', 'subtle.encrypt [RSA-OAEP-2048]', `Encrypted 256-bit session key (${decKeyHex.substring(0, 16)}...) -> 2048-bit ciphertext`);
  } catch (err) {
    console.error('RSA-OAEP failed:', err);
  }
};

// =========================================================================
// 4. Real RFC 7519 JWT Generation & HMAC-SHA256 Signing
// =========================================================================
window.runJwtSign = async function() {
  try {
    // Generate real HMAC-SHA256 key
    const hmacKey = await window.crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );

    const rawKey = await window.crypto.subtle.exportKey('raw', hmacKey);
    const keyHex = bufToHex(rawKey);

    // Real production JWT claims
    const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      iss: 'https://auth.cipherwire.link/oauth/v2',
      sub: 'usr_88942b01fa',
      aud: 'https://api.cipherwire.link/gateway',
      iat: now,
      exp: now + 3600,
      jti: '0bf75429-c85d-4f10-9f93-196be149adbc',
      role: 'security-operator',
      scope: 'kms:encrypt kms:decrypt stream:read'
    });

    const encodedHeader = strToBase64Url(header);
    const encodedPayload = strToBase64Url(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    // Sign with subtle.sign
    const signatureBuf = await window.crypto.subtle.sign(
      'HMAC',
      hmacKey,
      new TextEncoder().encode(signingInput)
    );

    const encodedSignature = base64UrlEncode(signatureBuf);
    const fullJwt = `${signingInput}.${encodedSignature}`;

    // Verify signature
    const isValid = await window.crypto.subtle.verify(
      'HMAC',
      hmacKey,
      signatureBuf,
      new TextEncoder().encode(signingInput)
    );

    document.getElementById('jwtKeyHex').textContent = keyHex;
    document.getElementById('jwtTokenVal').textContent = fullJwt;

    logEvent('JWT', 'term-tag-flow', 'RFC 7519 JWT Signed [HS256]', `Token: ${fullJwt.substring(0, 40)}... (Signature valid=${isValid})`);
  } catch (err) {
    console.error('JWT sign failed:', err);
  }
};

// =========================================================================
// 5. Real WebAssembly Binary Kernel Module Instantiation
// =========================================================================
window.runWasmModule = async function() {
  try {
    // Fetch and compile real WebAssembly binary
    const response = await fetch('kernel.wasm');
    const { instance } = await WebAssembly.instantiateStreaming(response);
    
    // Execute real exported function from WebAssembly kernel
    const computed = instance.exports.cipherTransform(100, 42);
    document.getElementById('wasmStatusVal').textContent = `Loaded kernel.wasm | cipherTransform(100, 42) -> ${computed}`;
    logEvent('WASM', 'term-tag-vm', 'WebAssembly Kernel Loaded', `WebAssembly.instantiateStreaming(kernel.wasm) -> exported cipherTransform executed: ${computed}`);
  } catch (err) {
    console.error('Wasm load failed:', err);
  }
};

// =========================================================================
// 6. Stack-based Bytecode Virtual Machine Dispatch Loop
// =========================================================================
window.vmInterpreter = function(bytecode) {
  let pc = 0;
  let sp = -1;
  const stack = new Int32Array(32);
  let result = 0;

  // Active dispatch loop traceable via --trace-vm "lab.js:vmInterpreter" --watch "pc,op,stack[sp]"
  while (pc < bytecode.length) {
    const op = bytecode[pc++];
    switch (op) {
      case 1: // LOAD_CONST
        stack[++sp] = bytecode[pc++];
        break;
      case 2: // ADD
        stack[sp - 1] = stack[sp - 1] + stack[sp];
        sp--;
        break;
      case 3: // XOR_CONST
        stack[sp] = stack[sp] ^ bytecode[pc++];
        break;
      case 4: // DUP
        stack[sp + 1] = stack[sp];
        sp++;
        break;
      case 99: // HALT
        result = stack[sp];
        return result;
      default:
        return result;
    }
  }
  return stack[sp];
};

window.runVM = function() {
  const bytecode = [1, 100, 1, 28, 2, 3, 0xff, 99];
  const out = window.vmInterpreter(bytecode);
  document.getElementById('vmOutVal').textContent = `VM Halted | Result = ${out} (0x${out.toString(16).toUpperCase()})`;
  logEvent('VM', 'term-tag-vm', 'vmInterpreter dispatch', `Executed bytecode sequence -> stack top = ${out}`);
};

// =========================================================================
// 7. Forward Dataflow Pipeline
// =========================================================================
window.generateSessionSignature = function(principal) {
  const nonce = window.crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
  const signature = 'sig_' + nonce + '_' + Date.now();
  return {
    principal,
    token: signature,
    issuedAt: Date.now()
  };
};

window.consumeSessionAuthorization = function(tokenObject) {
  window.__activeAuthSession = tokenObject.token;
  logEvent('FLOW', 'term-tag-flow', 'consumeSessionAuthorization', `Caller consumer accepted token: ${tokenObject.token}`);
  return true;
};

window.runDataflowFlow = function() {
  const token = window.generateSessionSignature('ops_admin_node');
  const accepted = window.consumeSessionAuthorization(token);
  document.getElementById('dfToken').textContent = token.token;
  document.getElementById('dfConsumer').textContent = 'consumeSessionAuthorization() -> accepted: ' + accepted;
};

// =========================================================================
// 8. Dean Edwards Packed DRM Content Key Delivery
// =========================================================================
window.runPackedScript = function() {
  // Evaluates real packed code delivering a 128-bit AES streaming key
  const packedCode = 'eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!\'\'.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}k=[function(e){return d[e]}];e=function(){return\'\\\\w+\'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp(\'\\\\b\'+e(c)+\'\\\\b\',\'g\'),k[c])}}return p}(\'2 1(){0 3="4";5 3}\',6,6,\'var|extractKey|function|ck|41424344454630313233343536373839|return\'.split(\'|\'),0,{}))';
  
  eval(packedCode);
  const extracted = window.extractKey ? window.extractKey() : '41424344454630313233343536373839';
  document.getElementById('packedKeyVal').textContent = extracted;
  logEvent('PACKER', 'term-tag-pack', 'Dean Edwards Unpacker', `Extracted AES-128 Content Key: ${extracted}`);
};

// =========================================================================
// 9. Real HLS EXT-X-KEY Manifest & Segment Fetch
// =========================================================================
window.runHlsFetch = async function() {
  try {
    const res = await fetch('stream/manifest.m3u8');
    const text = await res.text();
    document.getElementById('hlsManifestVal').textContent = text.split('\n')[4] || text;
    logEvent('HLS', 'term-tag-hls', 'HLS Manifest Fetched', 'EXT-X-KEY AES-128 URI="stream/enc.key" IV=0x53656372657449563030313132323333');

    // Fetch key file
    const keyRes = await fetch('stream/enc.key');
    const keyBuf = await keyRes.arrayBuffer();
    const hexKey = bufToHex(keyBuf);
    logEvent('HLS', 'term-tag-hls', 'HLS Key Downloaded', `AES-128 Key (16 bytes): ${hexKey}`);

    // Fetch encrypted transport stream segment
    const segRes = await fetch('stream/segment_0.ts');
    const segBuf = await segRes.arrayBuffer();
    logEvent('HLS', 'term-tag-hls', 'Encrypted Segment Fetched', `Downloaded segment_0.ts (${segBuf.byteLength} bytes)`);
  } catch (err) {
    logEvent('HLS', 'term-tag-hls', 'HLS Error', err.message);
  }
};

// =========================================================================
// 10. Obfuscated String Decoder Probe
// =========================================================================
window.runStringProbe = function() {
  const results = [];
  for (let i = 0; i < 4; i++) {
    try {
      results.push(`[${i}] "${window._0x4b12(i)}"`);
    } catch {
      break;
    }
  }
  document.getElementById('strDecoderVal').textContent = results.join('  ');
  logEvent('STRINGS', 'term-tag-strings', '_0x4b12() probe', `Decoded live: ${results[0]} ...`);
};

// =========================================================================
// 11. Heap Retention Memory Leaker (for --heap-diff)
// =========================================================================
window.__retained_security_context__ = [];
window.runHeapLeak = function() {
  for (let i = 0; i < 1500; i++) {
    window.__retained_security_context__.push({
      sessionId: 'sess_' + Math.random().toString(36).substring(2, 10),
      sessionToken: 'sk_live_' + Math.random().toString(36).substring(2, 15) + '_authenticated_session',
      kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/b6f5d840-81f1-4b19-b570-381c81ef40d2',
      allocatedAt: Date.now()
    });
  }
  document.getElementById('heapLeakVal').textContent = `Retained ${window.__retained_security_context__.length} live session credential objects in window.__retained_security_context__`;
  logEvent('HEAP', 'term-tag-strings', 'V8 Heap Memory Retention', `Allocated 1,500 active session token objects into V8 Heap`);
};

// =========================================================================
// Run All Target Subsystems Sequentially
// =========================================================================
window.runAllTargets = async function() {
  logEvent('SUITE', 'term-tag-crypto', 'Subsystem Initialization', 'Executing full cryptographic verification suite...');
  await window.runAesGcm();
  await window.runRsaOaep();
  await window.runJwtSign();
  await window.runWasmModule();
  window.runPackedScript();
  window.runStringProbe();
  window.runVM();
  window.runDataflowFlow();
  await window.runHlsFetch();
};

window.clearConsole = function() {
  if (termBody) termBody.innerHTML = '';
  eventCounter = 0;
  if (counterEl) counterEl.textContent = '0';
};

// Auto-run on page load
window.addEventListener('DOMContentLoaded', () => {
  window.runAllTargets();
});
