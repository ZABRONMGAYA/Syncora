/*
 * OrbitOne activation codes for KineticLane and Syncora — one file shared by the code maker
 * (browser page), the apps and the tests. It has no import/export: load it with <script src> in a
 * page or `await import()` in Node; either way it sets globalThis.OrbitActivation.
 * Needs WebCrypto Ed25519 (Node 20+, current Chrome/Edge/Firefox/Safari).
 *
 * A code is 117 characters of Crockford base32 (0-9 A-Z without I L O U; case and dashes ignored):
 *   payload (9 bytes): version · product · plan · expiry day (uint16, days since 2026-01-01) · serial (uint32)
 *   signature (64 bytes): Ed25519 over CONTEXT + payload
 * Only the private key on the owner's PC can sign; apps carry PUBLIC_KEY and check codes offline.
 * A code is valid up to and including its expiry day (the user's local date).
 */
(() => {
  // Ed25519 public key (JWK "x", base64url). Made by make-keys.mjs; the private half is not in git.
  const PUBLIC_KEY = 'cYhgokK-2UYrmOpNlr7SJij_nm386q5KoXuRxt1eTZg';

  const VERSION = 1;
  const CONTEXT = new TextEncoder().encode('OrbitOne activation v1');
  const PRODUCTS = { kineticlane: 1, syncora: 2, bundle: 3 }; // bundle unlocks both apps
  const PLANS = { month: 1, quarter: 2, year: 3, trial: 4, custom: 5 };
  const PLAN_MONTHS = { month: 1, quarter: 3, year: 12 };
  const TRIAL_DAYS = 7;
  const PAYLOAD_BYTES = 9;
  const CODE_BYTES = PAYLOAD_BYTES + 64;
  const EPOCH = Date.UTC(2026, 0, 1);
  const DAY_MS = 86400000;
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const nameOf = (table, id) => Object.keys(table).find((k) => table[k] === id) || null;
  const concat = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };

  function toBase32(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const b of bytes) {
      value = ((value << 8) | b) & 0xffff;
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
  }

  function fromBase32(text) {
    const clean = String(text)
      .toUpperCase()
      .replace(/[\s-]/g, '')
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0');
    const out = [];
    let bits = 0;
    let value = 0;
    for (const ch of clean) {
      const v = ALPHABET.indexOf(ch);
      if (v < 0) return null;
      value = ((value << 5) | v) & 0xffff;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }

  /* ── Dates (ISO "YYYY-MM-DD", calendar days, no time zones) ─────────────── */

  const dayNumber = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - EPOCH) / DAY_MS);
  const isoFromDay = (n) => new Date(EPOCH + n * DAY_MS).toISOString().slice(0, 10);
  const isIsoDate = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso));

  function localToday(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function addMonths(iso, months) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1 + months, d));
    if (date.getUTCDate() !== d) date.setUTCDate(0); // 31 Jan + 1 month → 28/29 Feb
    return date.toISOString().slice(0, 10);
  }

  /** Last valid day of a package that starts on `start`. `days` is only used by the custom plan. */
  function planExpiry(plan, start, days) {
    if (PLAN_MONTHS[plan]) return addMonths(start, PLAN_MONTHS[plan]);
    const length = plan === 'trial' ? TRIAL_DAYS : Number(days);
    if (!(length > 0)) throw new Error('Custom plan needs a number of days');
    return isoFromDay(dayNumber(start) + length);
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }

  /* ── Keys, signing, checking ───────────────────────────────────────────── */

  const ALGORITHM = { name: 'Ed25519' };
  const importPublic = (x) =>
    crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x }, ALGORITHM, false, ['verify']);
  const importPrivate = (jwk) =>
    crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x },
      ALGORITHM,
      false,
      ['sign'],
    );

  /** Signs a new code. `privateJwk` is the JSON from make-keys.mjs. Returns the code text. */
  async function makeCode({ product, plan, expires, serial }, privateJwk) {
    if (!PRODUCTS[product]) throw new Error(`Unknown product: ${product}`);
    if (!PLANS[plan]) throw new Error(`Unknown plan: ${plan}`);
    if (!isIsoDate(expires)) throw new Error(`Expiry must be YYYY-MM-DD: ${expires}`);
    const day = dayNumber(expires);
    if (day < 0 || day > 0xffff) throw new Error(`Expiry out of range: ${expires}`);

    const payload = new Uint8Array(PAYLOAD_BYTES);
    const view = new DataView(payload.buffer);
    payload[0] = VERSION;
    payload[1] = PRODUCTS[product];
    payload[2] = PLANS[plan];
    view.setUint16(3, day);
    view.setUint32(5, serial ?? crypto.getRandomValues(new Uint32Array(1))[0]);

    const key = await importPrivate(privateJwk);
    const signature = new Uint8Array(
      await crypto.subtle.sign(ALGORITHM, key, concat(CONTEXT, payload)),
    );
    return toBase32(concat(payload, signature));
  }

  /** Reads what a code says without checking its signature. Returns null if it isn't a code. */
  function readCode(code) {
    const bytes = fromBase32(code);
    if (!bytes || bytes.length !== CODE_BYTES || bytes[0] !== VERSION) return null;
    const product = nameOf(PRODUCTS, bytes[1]);
    const plan = nameOf(PLANS, bytes[2]);
    if (!product || !plan) return null;
    const view = new DataView(bytes.buffer);
    return {
      product,
      plan,
      expires: isoFromDay(view.getUint16(3)),
      serial: view.getUint32(5).toString(16).toUpperCase().padStart(8, '0'),
      payload: bytes.subarray(0, PAYLOAD_BYTES),
      signature: bytes.subarray(PAYLOAD_BYTES),
    };
  }

  /**
   * Checks a code for an app. Resolves to { ok, reason?, product, plan, expires, serial, daysLeft }.
   * reason: 'format' (not a code) · 'signature' (not made by OrbitOne) · 'product' (for the other app)
   * · 'expired'. `product` is the app asking ('kineticlane' or 'syncora'); a bundle code fits both.
   */
  async function checkCode(code, { product, today = localToday(), publicKey = PUBLIC_KEY } = {}) {
    const info = readCode(code);
    if (!info) return { ok: false, reason: 'format' };
    const key = await importPublic(publicKey);
    const genuine = await crypto.subtle.verify(
      ALGORITHM,
      key,
      info.signature,
      concat(CONTEXT, info.payload),
    );
    if (!genuine) return { ok: false, reason: 'signature' };
    const result = {
      product: info.product,
      plan: info.plan,
      expires: info.expires,
      serial: info.serial,
      daysLeft: dayNumber(info.expires) - dayNumber(today),
    };
    if (product && info.product !== product && info.product !== 'bundle')
      return { ok: false, reason: 'product', ...result };
    if (result.daysLeft < 0) return { ok: false, reason: 'expired', ...result };
    return { ok: true, ...result };
  }

  globalThis.OrbitActivation = {
    PUBLIC_KEY,
    PRODUCTS: Object.keys(PRODUCTS),
    PLANS: Object.keys(PLANS),
    TRIAL_DAYS,
    makeCode,
    readCode,
    checkCode,
    planExpiry,
    localToday,
    formatDate,
  };
})();
