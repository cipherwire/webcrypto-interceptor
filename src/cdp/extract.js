const http = require('http');
const https = require('https');
const dnsCallback = require('dns');
const dns = dnsCallback.promises;
const net = require('net');
// --full mode: dump every script source and response body seen on the page
// to disk, mirroring each URL's own path - a poor-man's "save whole site".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ponytail: one global dir per process run. Fine for "visit one page and
// extract it"; if extracting multiple different sites concurrently ever
// matters, key this map by targetUrl instead.
let extractDir = null;

function setExtractDir(targetUrl, baseDir) {
    let host = 'site';
    try {
        const u = new URL(targetUrl);
        host = u.hostname || 'site';
    } catch (e) {}
    host = host.replace(/[<>:"/\\|?*]/g, '_');
    extractDir = path.join(baseDir || process.cwd(), `${host}_extracted_${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    return extractDir;
}

function getExtractDir() {
    return extractDir;
}

// Returns null for anything that isn't a real fetched resource: puppeteer
// synthetic URLs (pptr:, __puppeteer_evaluation_script__), webpack://,
// blob:, data:, about: etc. Their "paths" are debugger sourceURLs / opaque
// ids, not real site structure - decoding them (e.g. pptr:'s %2F-encoded
// stack-frame paths) can otherwise forge arbitrary nested directories.
function urlToFilePath(url) {
    if (!extractDir) return null;
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    let p;
    try {
        p = decodeURIComponent(u.pathname);
    } catch (e) {
        p = u.pathname;
    }
    if (p === '' || p.endsWith('/')) p += 'index.html';
    if (!path.extname(p)) p += '.html'; // extensionless SPA routes/API calls -> readable file

    // Defense in depth: collapse '..'/'.' segments so a crafted path can
    // never escape extractDir even if a decoded segment contains them.
    // Also sanitize segments to replace characters illegal on Windows filesystem.
    const safeSegs = p.split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .map(seg => seg.replace(/[<>:"/\\|?*]/g, '_'))
        // Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        .map(seg => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(seg) ? '_' + seg : seg);
    if (!safeSegs.length) return null;
    return path.join(extractDir, u.hostname, ...safeSegs);
}

// Minified bundles/responses come back as one giant line - pretty-print
// text formats so the saved files are actually readable. Skips Buffers
// (binary content) and anything js-beautify/JSON.parse chokes on, falling
// back to the raw text untouched rather than losing the capture.
//
// js-beautify is required lazily: it is only needed in --full mode, and
// keeping it out of the module's load path lets the unit tests run without
// node_modules installed.
function prettify(target, content) {
    if (Buffer.isBuffer(content)) return content;
    // Guard: giant text bundles (>1MB) take seconds to beautify synchronously,
    // starving the Node.js event loop and dropping CDP packets. Save as-is.
    if (typeof content === 'string' && content.length > 1024 * 1024) return content;
    const ext = path.extname(target).toLowerCase();
    try {
        if (ext === '.js' || ext === '.css' || ext === '.html') {
            const beautify = require('js-beautify');
            if (ext === '.js') return beautify.js(content, { indent_size: 2 });
            if (ext === '.css') return beautify.css(content, { indent_size: 2 });
            return beautify.html(content, { indent_size: 2 });
        }
        if (ext === '.json') return JSON.stringify(JSON.parse(content), null, 2);
        // Extensionless API responses land as .html (SPA-route convention)
        // but are often JSON bodies - sniff and pretty-print those too,
        // before falling through to generic HTML beautify.
        if (ext === '.html' && /^\s*[{[]/.test(content)) return JSON.stringify(JSON.parse(content), null, 2);
    } catch (e) { /* not valid/parseable - save as-is below */ }
    return content;
}

// Collision handling: URLs that differ only in query string (or concurrent
// saves racing each other) used to silently overwrite the same mirrored
// path. First writer keeps the clean name; later ones get a short hash of
// the full URL spliced in before the extension. Repeat saves of the SAME
// url still overwrite (that's a re-fetch, not a collision).
const pathByUrl = new Map();   // full url -> final path (same url overwrites itself)
const usedPaths = new Set();   // every path ever handed out this session

function resolveTarget(url) {
    const filePath = urlToFilePath(url);
    if (!filePath) return null;

    const previous = pathByUrl.get(url);
    if (previous) return previous;

    let target = filePath;
    if (usedPaths.has(target)) {
        const hash = crypto.createHash('sha1').update(url).digest('hex').substring(0, 8);
        const ext = path.extname(target);
        target = path.join(path.dirname(target), path.basename(target, ext) + '_' + hash + ext);
    }
    pathByUrl.set(url, target);
    usedPaths.add(target);
    return target;
}

// url: source URL, or falsy/non-http for inline <script>/eval/internal
// sources (saved under _inline/).
function saveFile(url, content, scriptId, sourceMapUrl) {
    if (!extractDir) return;
    // Skip raw media segment chunks to avoid memory and disk bloat
    if (url && /\.(ts|m4s|m4v|mp4|webm|m4a|aac|mp3|flac)(\?|$)/i.test(url)) return;
    try {
        let target;
        if (url) {
            target = resolveTarget(url);
            if (!target) return;
        } else {
            target = path.join(extractDir, '_inline', `${scriptId || Date.now()}.js`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, prettify(target, content));

        const { trackExtractedFile } = require('../util/summary');
        trackExtractedFile(target);

        // If content is obfuscated with Dean Edwards packer, auto-unpack and save .unpacked companion
        const text = Buffer.isBuffer(content) ? null : (typeof content === 'string' ? content : null);
        if (text) {
            const { isPacked, unpack, extractContentKey } = require('../util/decoders');
            if (isPacked(text)) {
                try {
                    const unpacked = unpack(text);
                    if (unpacked && unpacked !== text) {
                        const ext = path.extname(target) || '.js';
                        const base = target.substring(0, target.length - ext.length);
                        const unpackedTarget = `${base}.unpacked${ext}`;
                        fs.writeFileSync(unpackedTarget, prettify(unpackedTarget, unpacked));
                        trackExtractedFile(unpackedTarget);

                        // Scan unpacked file for secrets and content keys
                        const { scanForSecrets, reportSecrets } = require('../util/secrets');
                        const findings = scanForSecrets(unpacked, url || 'inline');
                        if (findings.length) reportSecrets(findings, url || 'inline');

                        const ck = extractContentKey(unpacked);
                        if (ck) {
                            const { C } = require('../util/colors');
                            const { writeLog } = require('../util/log');
                            const { trackContentKey } = require('../util/summary');
                            console.log(`   ${C.hlred}🔑 CONTENT KEY (${ck.field}) from unpacked: ${ck.decoded}${C.reset}`);
                            writeLog({ type: 'content_key', url: url || 'inline', field: ck.field, raw: ck.raw, decoded: ck.decoded });
                            trackContentKey({ field: ck.field, raw: ck.raw, decoded: ck.decoded, url: url || '' });
                        }
                    }
                } catch (e) {}
            }
        }

        // Opportunistic sourcemap detection & recovery in the background
        handleSourcemap(url, content, sourceMapUrl).catch(() => {});
    } catch (e) { if (process.env.EXTRACT_DEBUG) console.error('saveFile ERR', url, e.message); }
}

const SOURCEMAP_RE = /(?:\/\/|\/\*)[#@] sourceMappingURL=([^\s*]+)/;
const seenMaps = new Set();

function cleanSourcePath(srcPath) {
    if (!srcPath || typeof srcPath !== 'string') return null;
    let p = srcPath.replace(/^(webpack|webpack-internal|rollup|vite|turbopack|file):\/\/?/i, '');
    p = p.replace(/^\[[^\]]+\]\//, '');
    p = p.split('?')[0].split('#')[0];
    p = p.replace(/\\/g, '/');
    p = p.replace(/^[a-zA-Z]:\//, '');
    const segs = p.split('/')
        .filter(s => s && s !== '.' && s !== '..')
        .map(s => s.replace(/[<>:"/\\|?*]/g, '_'))
        .map(s => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(s) ? '_' + s : s);
    if (!segs.length) return null;
    return path.join(...segs);
}

function unpackSourcemap(mapData, baseUrl, targetDir) {
    if (!mapData || !Array.isArray(mapData.sources)) return 0;
    const sources = mapData.sources;
    const contents = Array.isArray(mapData.sourcesContent) ? mapData.sourcesContent : [];
    if (!contents.length) return 0;

    let hostDir = 'sources';
    try {
        if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
            hostDir = new URL(baseUrl).hostname;
        }
    } catch (e) {}

    let count = 0;
    for (let i = 0; i < sources.length; i++) {
        const srcPath = sources[i];
        const srcContent = contents[i];
        if (!srcContent || typeof srcContent !== 'string') continue;

        const rel = cleanSourcePath(srcPath);
        if (!rel) continue;

        const dest = path.join(targetDir, '_sources', hostDir, rel);
        try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, srcContent, 'utf8');
            const { trackExtractedFile } = require('../util/summary');
            trackExtractedFile(dest);
            count++;
        } catch (e) {}
    }
    return count;
}

function isDisallowedHost(hostname) {
    if (!hostname || typeof hostname !== 'string') return true;
    let host = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
    if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') return true;
    if (host === 'metadata.google.internal') return true;

    // Check IPv4-mapped IPv6: ::ffff:127.0.0.1 or ::ffff:7f00:1
    if (host.startsWith('::ffff:')) {
        const v4Part = host.slice(7);
        if (v4Part.includes('.')) {
            return isDisallowedHost(v4Part);
        }
        const hexParts = v4Part.split(':');
        if (hexParts.length === 2) {
            const hi = parseInt(hexParts[0], 16);
            const lo = parseInt(hexParts[1], 16);
            if (!isNaN(hi) && !isNaN(lo)) {
                return isDisallowedHost(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
            }
        }
    }

    // Normalize potential numeric, octal, hex, or short IP representations using WHATWG parser
    try {
        const dummy = new URL('http://' + (host.includes(':') ? `[${host}]` : host));
        host = dummy.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch (e) {}

    if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') return true;

    // IPv4 check
    const parts = host.split('.');
    if (parts.length === 4 && parts.every(p => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
        const b0 = Number(parts[0]);
        const b1 = Number(parts[1]);
        if (b0 === 127) return true; // 127.0.0.0/8 loopback
        if (b0 === 10) return true;  // 10.0.0.0/8 private
        if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 link-local metadata
        if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16 private
        if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12 private
        if (b0 === 0) return true;
    }

    // IPv6 check
    if (host.includes(':')) {
        if (/^fe[89ab]/i.test(host)) return true; // fe80::/10 link-local
        if (/^f[cd]/i.test(host)) return true;   // fc00::/7 unique local
    }

    return false;
}

async function isDisallowedDns(hostname) {
    if (!hostname || typeof hostname !== 'string') return true;
    const cleanHost = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
    if (net.isIP(cleanHost)) {
        return isDisallowedHost(cleanHost);
    }
    if (isDisallowedHost(cleanHost)) {
        return true;
    }
    try {
        const addresses = await dns.lookup(cleanHost, { all: true });
        if (!addresses || !addresses.length) return true;
        for (const addr of addresses) {
            if (isDisallowedHost(addr.address)) {
                return true;
            }
        }
    } catch (e) {
        return true;
    }
    return false;
}

const nativeFetch = globalThis.fetch;

function connectionTimeLookup(hostname, options, callback) {
    dnsCallback.lookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err);
        if (!addresses || !addresses.length) {
            return callback(new Error('DNS resolution returned no addresses'));
        }
        for (const addr of addresses) {
            if (isDisallowedHost(addr.address)) {
                return callback(new Error('Connection-time SSRF blocked: IP ' + addr.address + ' is in a disallowed range'));
            }
        }
        const chosen = addresses[0];
        if (options && options.all) {
            callback(null, [chosen]);
        } else {
            callback(null, chosen.address, chosen.family);
        }
    });
}

async function fetchWithMockWrapper(urlStr, maxRedirects, timeoutMs, maxBytes) {
    let currentUrl = urlStr;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        let urlObj;
        try {
            urlObj = new URL(currentUrl);
        } catch (e) { return null; }

        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return null;
        if (isDisallowedHost(urlObj.hostname)) return null;
        if (await isDisallowedDns(urlObj.hostname)) return null;

        let resp;
        try {
            resp = await globalThis.fetch(urlObj.href, {
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (e) { return null; }

        if (!resp) return null;

        if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers && resp.headers.get ? resp.headers.get('location') : null;
            if (!loc) return null;
            try {
                currentUrl = new URL(loc, urlObj.href).href;
            } catch (e) { return null; }
            continue;
        }

        if (!resp.ok) return null;

        const cl = resp.headers && resp.headers.get ? resp.headers.get('content-length') : null;
        if (cl && parseInt(cl, 10) > maxBytes) return null;

        let textVal = '';
        if (typeof resp.text === 'function') {
            textVal = await resp.text();
            if (Buffer.byteLength(textVal) > maxBytes) return null;
        } else if (typeof resp.arrayBuffer === 'function') {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > maxBytes) return null;
            textVal = Buffer.from(buf).toString('utf8');
        }

        return {
            status: resp.status,
            finalUrl: urlObj.href,
            headers: resp.headers,
            text: () => textVal,
            buffer: () => Buffer.from(textVal)
        };
    }
    return null;
}

function fetchWithPinning(urlStr, maxRedirects = 3, timeoutMs = 5000, maxBytes = 10 * 1024 * 1024) {
    if (typeof globalThis.fetch === 'function' && globalThis.fetch !== nativeFetch) {
        return fetchWithMockWrapper(urlStr, maxRedirects, timeoutMs, maxBytes);
    }

    return new Promise((resolve) => {
        let currentUrl;
        try {
            currentUrl = new URL(urlStr);
        } catch (e) {
            return resolve(null);
        }

        if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') return resolve(null);
        if (isDisallowedHost(currentUrl.hostname)) return resolve(null);

        const isHttps = currentUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const reqOptions = {
            protocol: currentUrl.protocol,
            hostname: currentUrl.hostname,
            port: currentUrl.port || (isHttps ? 443 : 80),
            path: currentUrl.pathname + currentUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'webcrypto-interceptor/sourcemap',
                'Accept': 'application/json, */*'
            },
            lookup: connectionTimeLookup,
            timeout: timeoutMs
        };

        if (isHttps) {
            reqOptions.servername = currentUrl.hostname;
        }

        let req;
        try {
            req = client.request(reqOptions, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (maxRedirects <= 0) return resolve(null);
                    let nextUrl;
                    try {
                        nextUrl = new URL(res.headers.location, currentUrl).href;
                    } catch (e) {
                        return resolve(null);
                    }
                    return resolve(fetchWithPinning(nextUrl, maxRedirects - 1, timeoutMs, maxBytes));
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    return resolve(null);
                }

                const cl = res.headers['content-length'];
                if (cl && parseInt(cl, 10) > maxBytes) {
                    res.destroy();
                    return resolve(null);
                }

                const chunks = [];
                let totalBytes = 0;
                res.on('data', (chunk) => {
                    totalBytes += chunk.length;
                    if (totalBytes > maxBytes) {
                        res.destroy();
                        return resolve(null);
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const bodyBuf = Buffer.concat(chunks);
                    resolve({
                        status: res.statusCode,
                        finalUrl: currentUrl.href,
                        headers: res.headers,
                        text: () => bodyBuf.toString('utf8'),
                        buffer: () => bodyBuf
                    });
                });
            });
        } catch (e) {
            return resolve(null);
        }

        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });

        req.on('error', () => {
            resolve(null);
        });

        req.end();
    });
}

async function handleSourcemap(url, content, explicitSourceMapUrl) {
    if (!extractDir) return;
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
    let mapRef = null;
    if (text.includes('sourceMappingURL')) {
        const m = text.match(SOURCEMAP_RE);
        if (m) mapRef = m[1].trim();
    }
    if (!mapRef && explicitSourceMapUrl && typeof explicitSourceMapUrl === 'string') {
        mapRef = explicitSourceMapUrl.trim();
    }
    if (!mapRef) return;

    let mapJson = null;
    const MAX_MAP_SIZE = 10 * 1024 * 1024; // 10MB memory limit
    if (mapRef.startsWith('data:')) {
        try {
            if (mapRef.length > MAX_MAP_SIZE) return;
            if (mapRef.includes('base64,')) {
                mapJson = Buffer.from(mapRef.split('base64,')[1], 'base64').toString('utf8');
            } else if (mapRef.includes(',')) {
                mapJson = decodeURIComponent(mapRef.split(',')[1]);
            }
        } catch (e) { return; }
    } else {
        if (!url || !/^https?:\/\//i.test(url)) return;
        let mapUrlObj;
        try {
            mapUrlObj = new URL(mapRef, url);
        } catch (e) { return; }

        if (mapUrlObj.protocol !== 'http:' && mapUrlObj.protocol !== 'https:') return;
        if (isDisallowedHost(mapUrlObj.hostname)) return;

        let mapUrl = mapUrlObj.href;
        if (seenMaps.has(mapUrl)) return;
        seenMaps.add(mapUrl);

        try {
            const fetched = await fetchWithPinning(mapUrlObj.href);
            if (!fetched) return;
            mapJson = fetched.text();
            saveFile(fetched.finalUrl || mapUrl, mapJson);
        } catch (e) { return; }
    }

    if (!mapJson) return;
    try {
        const mapData = JSON.parse(mapJson);
        const count = unpackSourcemap(mapData, url, extractDir);
        if (count > 0) {
            const { C } = require('../util/colors');
            const { shortUrl } = require('../util/decoders');
            const { trackSourcesRecovered } = require('../util/summary');
            const { writeLog } = require('../util/log');
            trackSourcesRecovered(count);
            console.log(`\n${C.hlgrn}[🗺️  SOURCEMAP]${C.reset} Recovered ${count} original source file(s) from ${C.cyan}${shortUrl(url || 'script')}${C.reset} \u2192 ${C.dim}_sources/${C.reset}`);
            writeLog({ type: 'sourcemap_recovered', url, filesRecovered: count });
        }
    } catch (e) {}
}

// Test hook: clear per-session collision state.
function resetExtractState() {
    extractDir = null;
    pathByUrl.clear();
    usedPaths.clear();
    seenMaps.clear();
}

module.exports = {
    setExtractDir,
    getExtractDir,
    saveFile,
    isExtracting: () => !!extractDir,
    urlToFilePath,
    cleanSourcePath,
    unpackSourcemap,
    handleSourcemap,
    isDisallowedHost,
    isDisallowedDns,
    connectionTimeLookup,
    fetchWithPinning,
    resetExtractState
};
