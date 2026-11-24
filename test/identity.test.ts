import { strict as assert } from 'node:assert';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { test } from 'node:test';
import { canonical, Identity, signingPayload } from '../src/identity.ts';

// Fixed RFC 8032 test key (test vector 1), so payloads and fingerprints are reproducible.
const TEST_KEY = createPrivateKey({
  key: { kty: 'OKP', crv: 'Ed25519', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' },
  format: 'jwk',
});

test('canonical sorts keys, drops undefined and empty arrays, keeps nested order rules', () => {
  assert.equal(canonical({ b: 1, a: 'x', c: undefined, d: [], e: [{ z: 1, y: [] }] }), '{"a":"x","b":1,"e":[{"z":1}]}');
  assert.equal(canonical([1, undefined, null]), '[1,null,null]');
  assert.equal(canonical('héllo'), '"héllo"');
});

test('signing payload matches the hub format and ignores the signature field', () => {
  const args = { agent: 'banquet-captain', work: 'Work hub task', refs: ['task:tk_1'], files: [], signature: { at: 'x', nonce: 'y', sig: 'z' } };
  const p = signingPayload('agent_checkin', 'Banquet-Captain', '2026-11-24T01:00:00.000Z', 'abcdefghijklmnop', args);
  const lines = p.split('\n');
  assert.deepEqual(lines.slice(0, 5), ['hub-agent-v1', 'agent_checkin', 'banquet-captain', '2026-11-24T01:00:00.000Z', 'abcdefghijklmnop']);
  // sha256 of {"agent":"banquet-captain","refs":["task:tk_1"],"work":"Work hub task"}, cross-checked against flasun/hub signing.ts
  assert.equal(lines[5], '6d33d53ab31acbe7303a5ad4af22d8c5244e5ce9733dbedf95c1060aaf27eb87');
});

test('signCall produces a signature the public key verifies, with a valid nonce', () => {
  const id = Identity.fromKey(TEST_KEY);
  const args = { agent: 'banquet-captain', token: 'alt_test', progress: 'ok' };
  const s = id.signCall('agent_heartbeat', 'banquet-captain', args, new Date('2026-11-24T01:00:00Z'));
  assert.match(s.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  const payload = signingPayload('agent_heartbeat', 'banquet-captain', s.at, s.nonce, args);
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: id.publicKeyRaw() }, format: 'jwk' });
  assert.ok(verify(null, Buffer.from(payload, 'utf8'), pub, Buffer.from(s.sig, 'base64url')));
});

test('public key and fingerprint are stable for a fixed key', () => {
  const id = Identity.fromKey(TEST_KEY);
  assert.equal(id.publicKeyRaw(), '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
  assert.equal(id.fingerprint(), 'SHA256:If4x36FUomFia_hUBG_SJx'); // same value flasun/hub fingerprint() gives
});
