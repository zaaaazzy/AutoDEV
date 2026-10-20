import assert from 'node:assert/strict';
import test from 'node:test';
import { base32Decode, base32Encode, hotp, otpauthUri, verifyTotp } from './totp.js';

// RFC 6238, Anhang B: Schlüssel „12345678901234567890“, 59 s → 94287082 (6 Stellen: 287082)
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('computes RFC 6238 reference codes', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(hotp(RFC_SECRET, 1), '287082');
  assert.equal(hotp(RFC_SECRET, Math.floor(1111111109 / 30)), '081804');
  assert.equal(base32Decode(RFC_SECRET).toString(), '12345678901234567890');
});

test('accepts the current and neighbouring time step only', () => {
  const now = 1111111109 * 1000;
  assert.equal(verifyTotp(RFC_SECRET, '081804', now), Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(RFC_SECRET, '081 804', now), Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(RFC_SECRET, '000000', now), null);
  assert.equal(verifyTotp(RFC_SECRET, '081804', now + 5 * 60 * 1000), null);
  assert.equal(verifyTotp(RFC_SECRET, 'abc', now), null);
});

test('builds an otpauth link for authenticator apps', () => {
  assert.equal(
    otpauthUri('ABC', 'devlog'),
    'otpauth://totp/AIdeation%3Adevlog?secret=ABC&issuer=AIdeation&algorithm=SHA1&digits=6&period=30',
  );
});
