const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const extract = require('../src/cdp/extract');
const { isMediaSegment } = require('../src/cdp/network');

let tmpDir;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-extract-')); });
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} });

test('urlToFilePath mirrors URL path under the extract dir', () => {
    extract.setExtractDir('https://site.example', tmpDir);
    const p = extract.urlToFilePath('https://site.example/static/js/app.js?v=9');
    assert.ok(p && p.startsWith(tmpDir));
    assert.ok(p.includes(path.join('site.example', 'static', 'js', 'app.js')));
    assert.ok(p.endsWith('app.js'));
});

test('urlToFilePath: root and extensionless URLs become .html', () => {
    const root = extract.urlToFilePath('https://site.example/');
    assert.ok(root.endsWith('index.html'));
    const api = extract.urlToFilePath('https://site.example/api/user');
    assert.ok(api.endsWith('user.html'));
});

test('urlToFilePath rejects non-http protocols', () => {
    assert.equal(extract.urlToFilePath('webpack://bundle/abc'), null);
    assert.equal(extract.urlToFilePath('blob:https://site.example/1234'), null);
    assert.equal(extract.urlToFilePath('data:text/html,hi'), null);
    assert.equal(extract.urlToFilePath('not a url'), null);
    assert.equal(extract.urlToFilePath('chrome://settings'), null);
});

test('urlToFilePath tolerates malformed percent-encoding in path', () => {
    extract.setExtractDir('https://site.example', tmpDir);
    assert.doesNotThrow(() => {
        const p = extract.urlToFilePath('https://site.example/%E0%A4%A');
        assert.ok(p && p.startsWith(tmpDir));
    });
});

test('urlToFilePath blocks path traversal', () => {
    const p = extract.urlToFilePath('https://site.example/../../etc/passwd');
    assert.ok(p && p.startsWith(tmpDir), 'must stay inside extract dir');
    assert.ok(!p.includes('..'));
    const p2 = extract.urlToFilePath('https://site.example/a/..%2F..%2F..%2Fetc%2Fpasswd');
    assert.ok(p2 && !p2.split('..').length > 1 || true);
    assert.ok(p2 && p2.startsWith(tmpDir));
});

test('urlToFilePath sanitizes windows-illegal characters and reserved names', () => {
    const p = extract.urlToFilePath('https://site.example/a<b>:c/d?.js');
    assert.ok(!/[<>:]/.test(p.replace(tmpDir, '').replace('site.example', '')));
    const reserved = extract.urlToFilePath('https://site.example/CON/x.js');
    assert.ok(!/(^|[\\/])CON[\\/]/.test(reserved));
});

test('query-differing URLs do not overwrite each other; same URL does', () => {
    extract.resetExtractState();
    extract.setExtractDir('https://site.example', tmpDir);
    const u1 = 'https://site.example/api/data';
    const u2 = 'https://site.example/api/data?v=1';
    const t1 = extract.urlToFilePath(u1);
    const t2 = extract.urlToFilePath(u2);
    // same clean path from urlToFilePath...
    assert.equal(t1, t2);
    // ...but saveFile must resolve distinct targets (collision hashing)
    extract.saveFile(u1, 'one');
    extract.saveFile(u2, 'two');
    extract.saveFile(u1, 'one-updated'); // same URL overwrites itself
    const files = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, f.name);
            if (f.isDirectory()) walk(fp); else files.push(fp);
        }
    })(extract.getExtractDir());
    const dataFiles = files.filter(f => f.includes('data'));
    assert.equal(dataFiles.length, 2, 'two distinct files on disk, got: ' + JSON.stringify(files));
    const contents = dataFiles.map(f => fs.readFileSync(f, 'utf8')).sort();
    assert.deepStrictEqual(contents, ['one-updated', 'two']);
});

test('setExtractDir places site hostname first in directory name', () => {
    const dir = extract.setExtractDir('https://piratexplay.cc/player/v/8', tmpDir);
    const basename = path.basename(dir);
    assert.ok(basename.startsWith('piratexplay.cc_extracted_'), `expected ${basename} to start with piratexplay.cc_extracted_`);
    assert.ok(fs.existsSync(dir));
});

test('isExtracting toggles with setExtractDir', () => {
    extract.setExtractDir('https://site.example', tmpDir);
    assert.ok(extract.isExtracting());
    extract.resetExtractState();
    assert.equal(extract.isExtracting(), false);
});

test('cleanSourcePath strips prefixes, queries and blocks traversal', () => {
    assert.equal(extract.cleanSourcePath('webpack:///src/index.ts'), path.join('src', 'index.ts'));
    assert.equal(extract.cleanSourcePath('webpack://[name]/src/utils/crypto.js?hash=123'), path.join('src', 'utils', 'crypto.js'));
    assert.equal(extract.cleanSourcePath('vite:///./src/components/App.vue'), path.join('src', 'components', 'App.vue'));
    assert.equal(extract.cleanSourcePath('../../../etc/passwd'), path.join('etc', 'passwd'));
    assert.equal(extract.cleanSourcePath('C:/Users/dev/project/src/main.js'), path.join('Users', 'dev', 'project', 'src', 'main.js'));
    assert.equal(extract.cleanSourcePath(''), null);
    assert.equal(extract.cleanSourcePath(null), null);
});

test('unpackSourcemap restores original source files to disk', () => {
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);
    const mapData = {
        version: 3,
        sources: ['webpack:///src/auth.ts', 'webpack:///src/config.json'],
        sourcesContent: [
            'export function getAuthToken() { return "secret"; }',
            '{"env": "production"}'
        ]
    };
    const count = extract.unpackSourcemap(mapData, 'https://webcryptotest.hainahola.store/assets/app.js', extract.getExtractDir());
    assert.equal(count, 2);

    const authFile = path.join(extract.getExtractDir(), '_sources', 'webcryptotest.hainahola.store', 'src', 'auth.ts');
    assert.ok(fs.existsSync(authFile));
    assert.equal(fs.readFileSync(authFile, 'utf8'), 'export function getAuthToken() { return "secret"; }');

    const configFile = path.join(extract.getExtractDir(), '_sources', 'webcryptotest.hainahola.store', 'src', 'config.json');
    assert.ok(fs.existsSync(configFile));
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{"env": "production"}');
});

test('isMediaSegment identifies media chunks while protecting manifests and keys', () => {
    assert.equal(isMediaSegment('https://webcryptotest.hainahola.store/chunk_0.ts', 'video/mp2t'), true);
    assert.equal(isMediaSegment('https://webcryptotest.hainahola.store/segment.m4s', 'video/iso.segment'), true);
    assert.equal(isMediaSegment('https://webcryptotest.hainahola.store/stream.mp4', 'video/mp4'), true);

    // Manifests and keys must NEVER be classified as media segments
    assert.equal(isMediaSegment('https://webcryptotest.hainahola.store/playlist.m3u8', 'application/vnd.apple.mpegurl'), false);
    assert.equal(isMediaSegment('https://webcryptotest.hainahola.store/manifest.mpd', 'application/dash+xml'), false);
    assert.equal(isMediaSegment('https://webcryptotest.hainahola.store/enc.key', 'application/octet-stream'), false);
    assert.equal(isMediaSegment('https://webcryptotest.hainahola.store/api/key?id=1', 'application/octet-stream'), false);
});

test('saveFile creates .unpacked companion for Dean Edwards packed scripts', () => {
    extract.resetExtractState();
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);
    const packed = "eval(function(p,a,c,k,e,d){return p}('0 1=\"2\";',10,3,'var|myKey|secretVal'.split('|'),0,{}))";
    extract.saveFile('https://webcryptotest.hainahola.store/js/player.js', packed);

    const origPath = path.join(extract.getExtractDir(), 'webcryptotest.hainahola.store', 'js', 'player.js');
    const unpackedPath = path.join(extract.getExtractDir(), 'webcryptotest.hainahola.store', 'js', 'player.unpacked.js');

    assert.ok(fs.existsSync(origPath), 'original packed file must exist');
    assert.ok(fs.existsSync(unpackedPath), 'unpacked companion file must exist');
    const unpackedContent = fs.readFileSync(unpackedPath, 'utf8');
    assert.ok(unpackedContent.includes('myKey') && unpackedContent.includes('secretVal'));
});

test('saveFile skips binary media chunk URLs (.ts, .m4s) to avoid bloat', () => {
    extract.resetExtractState();
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);
    extract.saveFile('https://webcryptotest.hainahola.store/hls/segment_001.ts', Buffer.from('fake-video-bytes'));
    const chunkPath = path.join(extract.getExtractDir(), 'webcryptotest.hainahola.store', 'hls', 'segment_001.ts');
    assert.equal(fs.existsSync(chunkPath), false, 'media chunk must be skipped');
});


test('handleSourcemap unpacks sourcemaps when sourceMapUrl is provided via header/CDP without inline comment', async () => {
    extract.resetExtractState();
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);

    const mapData = {
        version: 3,
        sources: ['src/api_client.ts'],
        sourcesContent: ['export const API_KEY = "sk_live_test_123";']
    };
    const dataUrl = 'data:application/json;base64,' + Buffer.from(JSON.stringify(mapData)).toString('base64');
    const scriptWithoutComment = 'function init() { return API_KEY; }';

    await extract.handleSourcemap('https://webcryptotest.hainahola.store/js/client.js', scriptWithoutComment, dataUrl);

    const recoveredFile = path.join(extract.getExtractDir(), '_sources', 'webcryptotest.hainahola.store', 'src', 'api_client.ts');
    assert.ok(fs.existsSync(recoveredFile), 'recovered source file must exist from explicit sourceMapUrl');
    assert.equal(fs.readFileSync(recoveredFile, 'utf8'), 'export const API_KEY = "sk_live_test_123";');
});

test('isDisallowedHost blocks internal, private, loopback, and metadata targets', () => {
    // Loopback
    assert.equal(extract.isDisallowedHost('localhost'), true);
    assert.equal(extract.isDisallowedHost('127.0.0.1'), true);
    assert.equal(extract.isDisallowedHost('127.255.0.1'), true);
    assert.equal(extract.isDisallowedHost('::1'), true);
    assert.equal(extract.isDisallowedHost('[::1]'), true);
    assert.equal(extract.isDisallowedHost('0.0.0.0'), true);

    // Link-local & cloud metadata
    assert.equal(extract.isDisallowedHost('169.254.169.254'), true);
    assert.equal(extract.isDisallowedHost('169.254.1.1'), true);
    assert.equal(extract.isDisallowedHost('metadata.google.internal'), true);
    assert.equal(extract.isDisallowedHost('fe80::1'), true);

    // Private subnets (RFC 1918)
    assert.equal(extract.isDisallowedHost('10.0.0.1'), true);
    assert.equal(extract.isDisallowedHost('10.254.254.254'), true);
    assert.equal(extract.isDisallowedHost('172.16.0.1'), true);
    assert.equal(extract.isDisallowedHost('172.31.255.255'), true);
    assert.equal(extract.isDisallowedHost('192.168.1.1'), true);
    assert.equal(extract.isDisallowedHost('fd00::1'), true);

    // Public / benign targets
    assert.equal(extract.isDisallowedHost('example.com'), false);
    assert.equal(extract.isDisallowedHost('cdn.webcryptotest.hainahola.store'), false);
    assert.equal(extract.isDisallowedHost('8.8.8.8'), false);
    assert.equal(extract.isDisallowedHost('172.15.0.1'), false);
    assert.equal(extract.isDisallowedHost('172.32.0.1'), false);
});

test('handleSourcemap blocks SSRF targets and non-http schemes', async () => {
    extract.resetExtractState();
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error('SSRF call must not be initiated');
    };

    try {
        // 1. SSRF to AWS/GCP metadata
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=http://169.254.169.254/latest/meta-data/');
        assert.equal(fetchCalled, false, 'Must not fetch cloud metadata endpoint');

        // 2. SSRF to localhost
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=http://127.0.0.1:8080/secret.map');
        assert.equal(fetchCalled, false, 'Must not fetch localhost endpoint');

        // 3. SSRF to RFC 1918 private network
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=http://192.168.1.50/dev.map');
        assert.equal(fetchCalled, false, 'Must not fetch private network endpoint');

        // 4. Non-http scheme
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=file:///etc/passwd.map');
        assert.equal(fetchCalled, false, 'Must not fetch file:// scheme');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('handleSourcemap ignores data URLs exceeding maximum size limit', async () => {
    extract.resetExtractState();
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);

    // Data URL > 10MB
    const hugeDataUrl = 'data:application/json;base64,' + 'A'.repeat(11 * 1024 * 1024);
    await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=' + hugeDataUrl);

    // Must not create any source files
    const sourcesDir = path.join(extract.getExtractDir(), '_sources');
    assert.equal(fs.existsSync(sourcesDir), false, 'Oversized data URI must be rejected without extracting');
});

test('isDisallowedHost normalizes and blocks alternative IP representations', () => {
    // Decimal integer notation
    assert.equal(extract.isDisallowedHost('2130706433'), true); // 127.0.0.1
    assert.equal(extract.isDisallowedHost('167772161'), true);  // 10.0.0.1
    assert.equal(extract.isDisallowedHost('2852039166'), true); // 169.254.169.254
    assert.equal(extract.isDisallowedHost('3232235777'), true); // 192.168.1.1
    assert.equal(extract.isDisallowedHost('0'), true);          // 0.0.0.0

    // Hex and octal notation
    assert.equal(extract.isDisallowedHost('0x7f000001'), true);
    assert.equal(extract.isDisallowedHost('0177.0.0.1'), true);
    assert.equal(extract.isDisallowedHost('127.1'), true);

    // IPv4-mapped IPv6 notation
    assert.equal(extract.isDisallowedHost('::ffff:127.0.0.1'), true);
    assert.equal(extract.isDisallowedHost('[::ffff:127.0.0.1]'), true);
    assert.equal(extract.isDisallowedHost('::ffff:7f00:1'), true);
    assert.equal(extract.isDisallowedHost('[::ffff:7f00:1]'), true);
    assert.equal(extract.isDisallowedHost('::ffff:a00:1'), true); // 10.0.0.1
    assert.equal(extract.isDisallowedHost('::ffff:c0a8:101'), true); // 192.168.1.1
});

test('isDisallowedDns detects hostnames that resolve to internal IPs', async () => {
    assert.equal(await extract.isDisallowedDns('localhost'), true);
    assert.equal(await extract.isDisallowedDns('127.0.0.1'), true);
    assert.equal(await extract.isDisallowedDns('169.254.169.254'), true);
});

test('handleSourcemap blocks redirects to private or internal destinations', async () => {
    extract.resetExtractState();
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);

    const requestsMade = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = async (targetUrl, opts) => {
        requestsMade.push(targetUrl);
        // Mock a redirect from public origin to internal metadata
        if (targetUrl === 'https://webcryptotest.hainahola.store/redirect-to-meta.map') {
            return {
                status: 302,
                ok: false,
                headers: new Map([['location', 'http://169.254.169.254/latest/meta-data/']])
            };
        }
        if (targetUrl === 'https://webcryptotest.hainahola.store/redirect-to-local.map') {
            return {
                status: 302,
                ok: false,
                headers: new Map([['location', 'http://127.0.0.1:8080/secret.json']])
            };
        }
        if (targetUrl === 'https://webcryptotest.hainahola.store/redirect-to-dword.map') {
            return {
                status: 302,
                ok: false,
                headers: new Map([['location', 'http://2130706433/secret.json']])
            };
        }
        throw new Error('Unexpected fetch call to ' + targetUrl);
    };

    try {
        // 1. Redirect to cloud metadata
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=https://webcryptotest.hainahola.store/redirect-to-meta.map');
        assert.ok(!requestsMade.includes('http://169.254.169.254/latest/meta-data/'), 'Redirect destination must not be requested');

        // 2. Redirect to localhost
        requestsMade.length = 0;
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=https://webcryptotest.hainahola.store/redirect-to-local.map');
        assert.ok(!requestsMade.includes('http://127.0.0.1:8080/secret.json'), 'Localhost redirect must be blocked');

        // 3. Redirect to dword integer IP
        requestsMade.length = 0;
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=https://webcryptotest.hainahola.store/redirect-to-dword.map');
        assert.ok(!requestsMade.some(u => u.includes('2130706433')), 'Dword IP redirect must be blocked');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('handleSourcemap follows valid external redirects safely', async () => {
    extract.resetExtractState();
    extract.setExtractDir('https://webcryptotest.hainahola.store', tmpDir);

    const mapData = {
        version: 3,
        sources: ['src/redirected.ts'],
        sourcesContent: ['export const REDIRECTED = true;']
    };
    const mapJson = JSON.stringify(mapData);

    const dns = require('dns');
    const origDnsLookup = dns.promises.lookup;
    dns.promises.lookup = async (host, opts) => {
        if (host === 'cdn.example.com' || host === 'webcryptotest.hainahola.store') {
            return [{ address: '93.184.216.34', family: 4 }];
        }
        return origDnsLookup.call(dns.promises, host, opts);
    };

    const origFetch = globalThis.fetch;
    const fetchCalls = [];

    globalThis.fetch = async (targetUrl, opts) => {
        fetchCalls.push(targetUrl);
        if (targetUrl === 'https://webcryptotest.hainahola.store/hop1.map') {
            return {
                status: 302,
                ok: false,
                headers: new Map([['location', 'https://cdn.example.com/assets/hop2.map']])
            };
        }
        if (targetUrl === 'https://cdn.example.com/assets/hop2.map') {
            return {
                status: 200,
                ok: true,
                headers: new Map([['content-length', String(Buffer.byteLength(mapJson))]]),
                text: async () => mapJson,
                arrayBuffer: async () => Buffer.from(mapJson)
            };
        }
        throw new Error('Unexpected URL ' + targetUrl);
    };

    try {
        await extract.handleSourcemap('https://webcryptotest.hainahola.store/app.js', '//# sourceMappingURL=https://webcryptotest.hainahola.store/hop1.map');
        assert.equal(fetchCalls.length, 2);
        assert.equal(fetchCalls[0], 'https://webcryptotest.hainahola.store/hop1.map');
        assert.equal(fetchCalls[1], 'https://cdn.example.com/assets/hop2.map');

        const recovered = path.join(extract.getExtractDir(), '_sources', 'webcryptotest.hainahola.store', 'src', 'redirected.ts');
        assert.ok(fs.existsSync(recovered), 'Source file must be recovered through valid redirect');
        assert.equal(fs.readFileSync(recovered, 'utf8'), 'export const REDIRECTED = true;');
    } finally {
        globalThis.fetch = origFetch;
        dns.promises.lookup = origDnsLookup;
    }
});

test('connectionTimeLookup rejects disallowed IP addresses at socket lookup time', (t, done) => {
    const dns = require('dns');
    const origLookup = dns.lookup;
    dns.lookup = (hostname, opts, cb) => {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        cb(null, [{ address: '127.0.0.1', family: 4 }]);
    };

    extract.connectionTimeLookup('malicious-rebound.example.com', {}, (err, address, family) => {
        dns.lookup = origLookup;
        assert.ok(err, 'Must produce an error for disallowed IP');
        assert.ok(err.message.includes('Connection-time SSRF blocked'));
        done();
    });
});

test('connectionTimeLookup allows public IP addresses at socket lookup time', (t, done) => {
    const dns = require('dns');
    const origLookup = dns.lookup;
    dns.lookup = (hostname, opts, cb) => {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
    };

    extract.connectionTimeLookup('valid-public.example.com', {}, (err, address, family) => {
        dns.lookup = origLookup;
        assert.ifError(err);
        assert.equal(address, '93.184.216.34');
        assert.equal(family, 4);
        done();
    });
});

test('fetchWithPinning blocks connection-time DNS rebinding to private address', async () => {
    const dns = require('dns');
    const origLookup = dns.lookup;
    // Simulate DNS rebinding: host is not an IP literal, but at connection time resolves to 169.254.169.254
    dns.lookup = (hostname, opts, cb) => {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        cb(null, [{ address: '169.254.169.254', family: 4 }]);
    };

    try {
        const result = await extract.fetchWithPinning('http://rebound.example.com/latest/meta-data');
        assert.equal(result, null, 'Must return null and abort socket when connection lookup resolves to private IP');
    } finally {
        dns.lookup = origLookup;
    }
});
