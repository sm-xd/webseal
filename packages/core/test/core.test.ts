import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  sha256Hex,
  manifestHash,
  formatRecord,
  parseRecord,
  normalizePath,
  deriveNameFromHost,
  verifyFiles,
  extractInlineScripts,
  verifyInline,
  verifyDocument,
  sha256HexJs,
  type Manifest,
} from '../src/index.ts';

test('canonicalize sorts keys and drops undefined', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [1, 2], c: undefined } }), '{"a":{"d":[1,2]},"b":1}');
});

test('manifest hash is order independent', async () => {
  const a: Manifest = { version: 1, files: { '/a.js': 'a'.repeat(64), '/b.js': 'b'.repeat(64) } };
  const b: Manifest = { files: { '/b.js': 'b'.repeat(64), '/a.js': 'a'.repeat(64) }, version: 1 };
  assert.equal(await manifestHash(a), await manifestHash(b));
});

test('sha256 of empty string is the known constant', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('record round trip', async () => {
  const h = await sha256Hex('x');
  assert.deepEqual(parseRecord(formatRecord(h)), { hash: h, hashes: [h] });
  const h2 = await sha256Hex('y');
  assert.deepEqual(parseRecord(formatRecord([h2, h])), { hash: h2, hashes: [h2, h] });
  assert.equal(formatRecord([h, h]), formatRecord(h));
  assert.equal(parseRecord(`v1:sha256:${h},${h2},${h}`), null);
  assert.throws(() => formatRecord([h, h2, 'c'.repeat(64)]));
  assert.equal(parseRecord('garbage'), null);
  assert.equal(parseRecord('v1:sha256:zz'), null);
});

test('normalizePath', () => {
  assert.equal(normalizePath(''), '/index.html');
  assert.equal(normalizePath('/'), '/index.html');
  assert.equal(normalizePath('/app/'), '/app/index.html');
  assert.equal(normalizePath('/a.js?v=2#x'), '/a.js');
  assert.equal(normalizePath('http://x.test/assets/i.js?q'), '/assets/i.js');
  assert.equal(normalizePath('assets//i.js'), '/assets/i.js');
});

test('deriveNameFromHost', () => {
  assert.equal(deriveNameFromHost('app.eth.limo'), 'app.eth');
  assert.equal(deriveNameFromHost('sub.app.eth.link:443'), 'sub.app.eth');
  assert.equal(deriveNameFromHost('localhost:4173'), null);
});

test('verifyFiles reports ok, mismatch, missing, unlisted', async () => {
  const good = new TextEncoder().encode('console.log(1)');
  const manifest: Manifest = {
    version: 1,
    files: { '/a.js': await sha256Hex(good), '/b.js': 'c'.repeat(64), '/gone.js': 'd'.repeat(64) },
  };
  const fetcher = async (p: string) =>
    p === '/a.js' ? good : p === '/b.js' ? new TextEncoder().encode('evil') : null;
  const res = await verifyFiles(manifest, ['/a.js?x=1', '/b.js', '/gone.js', '/injected.js'], fetcher);
  const byPath = Object.fromEntries(res.map((r) => [r.path, r.status]));
  assert.deepEqual(byPath, { '/a.js': 'ok', '/b.js': 'mismatch', '/gone.js': 'missing', '/injected.js': 'unlisted' });
});

test('inline scripts are extracted and verified', async () => {
  const html = `<html><script src="/a.js"></script><script>window.x=1</script><script type="application/json">{}</script></html>`;
  const bodies = extractInlineScripts(html);
  assert.deepEqual(bodies, ['window.x=1']);
  const manifest: Manifest = { version: 1, files: {}, inline: [await sha256Hex('window.x=1')] };
  const res = await verifyInline(manifest, bodies);
  assert.equal(res[0].status, 'ok');
  const bad = await verifyInline(manifest, ['alert(1)']);
  assert.equal(bad[0].status, 'unlisted');
});

test('verifyDocument accepts client-side routes only when the HTML is a release page', async () => {
  const enc = new TextEncoder();
  const index = enc.encode('<html>app</html>');
  const manifest: Manifest = { version: 1, files: { '/index.html': await sha256Hex(index), '/a.js': 'a'.repeat(64) } };
  const spa = async () => index;
  assert.equal((await verifyDocument(manifest, '/', spa)).status, 'ok');
  const route = await verifyDocument(manifest, '/dashboard?tab=2', spa);
  assert.equal(route.status, 'ok');
  assert.equal(route.note, 'served as /index.html');
  const other = await verifyDocument(manifest, '/dashboard', async () => enc.encode('<html>evil</html>'));
  assert.equal(other.status, 'unlisted');
  assert.equal((await verifyDocument(manifest, '/index.html', async () => enc.encode('x'))).status, 'mismatch');
  assert.equal((await verifyDocument(manifest, '/gone', async () => null)).status, 'missing');
});

test('JS SHA-256 fallback matches Web Crypto on block-boundary and large inputs', async () => {
  const { randomBytes } = await import('node:crypto');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const bytes = new Uint8Array(randomBytes(n));
    assert.equal(sha256HexJs(bytes), await sha256Hex(bytes), `length ${n}`);
  }
  assert.equal(sha256HexJs(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
