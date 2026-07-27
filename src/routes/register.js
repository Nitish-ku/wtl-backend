const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb, admin } = require('../services/firestore');

// --- Validation rules -----------------------------------------------------
// Mirrored from index.html's own client-side validation (emailRe/phoneRe) and
// the .chrono card data-value attributes, so the backend rejects exactly what
// the frontend would never have sent in the first place. This endpoint is
// public (no auth), so it can't rely on the frontend having run at all.
const NAME_MAX_LEN = 100;
const EMAIL_MAX_LEN = 254; // RFC 5321 max mailbox length
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // matches index.html emailRe
const PHONE_RE = /^\+91[6-9]\d{9}$/; // index.html sends "+91" + phoneRe-validated 10 digits
const CHRONOTYPES = new Set(['early_bird', 'day_operator', 'night_owl']); // matches .chrono data-value

function validatePayload(body) {
  // strip control characters after trimming: defensive groundwork against a future stored-XSS
  // source once an admin panel or PDF export renders this field
  const name = typeof body.name === 'string' ? body.name.trim().replace(/[\x00-\x1F\x7F]/g, '') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const chronotype = typeof body.chronotype === 'string' ? body.chronotype : '';

  const errors = [];
  if (!name) errors.push('name is required');
  else if (name.length > NAME_MAX_LEN) errors.push(`name must be ${NAME_MAX_LEN} characters or fewer`);

  if (!email) errors.push('email is required');
  else if (email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) errors.push('email must be a valid email address');

  if (!phone) errors.push('phone is required');
  else if (!PHONE_RE.test(phone)) errors.push('phone must be a valid Indian mobile number (+91 followed by 10 digits starting 6-9)');

  if (!chronotype) errors.push('chronotype is required');
  else if (!CHRONOTYPES.has(chronotype)) errors.push(`chronotype must be one of: ${[...CHRONOTYPES].join(', ')}`);

  return { errors, clean: { name, email, phone, chronotype } };
}

// --- Lightweight per-instance rate limiter --------------------------------
// Cloud Run can (and will, under a real traffic spike) run multiple instances
// of this service, and this Map is process-local memory, so it does NOT give
// a hard guarantee across instances, an attacker (or just retried requests
// during scale-up) spread across instances is only partially slowed down.
// This is a deliberate "better than nothing tonight" tradeoff, not a real
// distributed limiter. If this endpoint sees actual abuse, replace this with
// a Firestore- or Redis-backed limiter keyed by IP/phone/email.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
// Indian mobile carriers (Jio, Airtel) run large-scale CGNAT, so thousands of real users can
// share one public IP. 8/window was verified to false-positive-block legitimate traffic during
// exactly the kind of push this endpoint serves, raised for tonight. The duplicate-registration
// guard below (email+phone) is what actually stops real abuse, this is just a backstop.
const RATE_LIMIT_MAX = 60; // max submissions per IP per window, per instance
// Tighter secondary limit keyed on the submitter's own identity (email+phone), so genuine
// same-person/bot abuse is still caught even though the IP limit above had to be loosened.
const IDENTITY_RATE_LIMIT_MAX = 5; // max submissions per email+phone combo per window, per instance
const rateLimitHits = new Map(); // ip -> timestamps[]
const identityRateLimitHits = new Map(); // "email|phone" -> timestamps[]

// Bounds the stored timestamp array after every check (previously unbounded, which made the
// per-request .filter() get slower and slower under sustained traffic from one key, verified
// to hit ~22s of blocking CPU at 40k hits from one IP within the window, since Node is
// single-threaded this stalled every other route too, not just registration).
function checkAndRecordHit(map, key, max) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  map.set(key, recent.slice(-(max + 1)));
  return recent.length > max;
}

// periodic cleanup so these Maps can't grow unbounded over the life of an instance
setInterval(() => {
  const now = Date.now();
  for (const map of [rateLimitHits, identityRateLimitHits]) {
    for (const [key, timestamps] of map) {
      const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (fresh.length === 0) map.delete(key);
      else map.set(key, fresh);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// --- Duplicate registration lookup ----------------------------------------
async function findExistingRegistration(db, email, phone) {
  const [byEmail, byPhone] = await Promise.all([
    db.collection('registrations').where('email', '==', email).limit(1).get(),
    db.collection('registrations').where('phone', '==', phone).limit(1).get(),
  ]);
  if (!byEmail.empty) return byEmail.docs[0];
  if (!byPhone.empty) return byPhone.docs[0];
  return null;
}

// --- Referral code generation ----------------------------------------------
// 6-char base36 uppercase = 36^6 (~2.18B) possible codes. At the expected
// scale here (hundreds of registrations per cohort, not millions), the
// birthday-paradox collision odds are negligible on their own (~0.02% at
// n=1000). We still check-and-retry against Firestore below because it's a
// single indexed equality query (cheap, no composite index needed) and
// removes the risk entirely rather than just judging it "probably fine".
const REF_CODE_MAX_ATTEMPTS = 5;

function randomRefCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function generateUniqueRefCode(db) {
  for (let attempt = 0; attempt < REF_CODE_MAX_ATTEMPTS; attempt++) {
    const code = randomRefCode();
    const existing = await db.collection('registrations').where('ref', '==', code).limit(1).get();
    if (existing.empty) return code;
  }
  // Extremely unlikely fallback (5 straight collisions): append a timestamp
  // slice so this never blocks a registration outright.
  return `${randomRefCode().slice(0, 4)}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

router.post('/', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (checkAndRecordHit(rateLimitHits, ip, RATE_LIMIT_MAX)) {
    return res.status(429).json({ error: 'Too many registration attempts. Please try again in a few minutes.' });
  }

  const body = req.body || {};
  const { errors, clean } = validatePayload(body);
  if (errors.length) {
    return res.status(400).json({ error: errors[0], errors });
  }

  const identityKey = `${clean.email}|${clean.phone}`;
  if (checkAndRecordHit(identityRateLimitHits, identityKey, IDENTITY_RATE_LIMIT_MAX)) {
    return res.status(429).json({ error: 'Too many registration attempts. Please try again in a few minutes.' });
  }

  // `paid` is intentionally never read from the client: payment happens out-of-band on
  // Cosmofeed/SuperProfile with no reconciliation webhook, so this field is a manual-
  // reconciliation input, not something a POST body should be able to set to true for free.
  const { src, bumpIntent, lateSignup, consent, consentAt, userAgent } = body;

  try {
    const db = getDb();

    // Idempotent registration, fast path: catches both genuine resubmissions and any
    // pre-existing rows written before the atomic guard-collection approach below existed.
    const existing = await findExistingRegistration(db, clean.email, clean.phone);
    if (existing) {
      return res.json({ success: true });
    }

    const ref = await generateUniqueRefCode(db);
    const registration = {
      name: clean.name,
      email: clean.email,
      phone: clean.phone,
      chronotype: clean.chronotype,
      src: typeof src === 'string' && src.trim() ? src.trim().slice(0, 50) : 'unknown',
      paid: false,
      bumpIntent: !!bumpIntent,
      lateSignup: !!lateSignup,
      consent: !!consent,
      consentAt: typeof consentAt === 'string' && consentAt.length <= 40 ? consentAt : null,
      ref,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Atomic duplicate guard: two near-simultaneous requests with the same email/phone can
    // both pass the findExistingRegistration() read above before either write commits. Email
    // is hashed rather than used as a raw document ID because EMAIL_RE permits "/" characters
    // (e.g. "a/b@x.com"), which would corrupt the Firestore document path.
    const emailKey = crypto.createHash('sha256').update(clean.email).digest('hex');
    const regDocRef = db.collection('registrations').doc();
    const batch = db.batch();
    batch.create(db.collection('reg_uniq_email').doc(emailKey), {
      regDocPath: regDocRef.path,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.create(db.collection('reg_uniq_phone').doc(clean.phone), {
      regDocPath: regDocRef.path,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.create(regDocRef, registration);

    try {
      await batch.commit();
    } catch (e) {
      if (e.code === 6 /* ALREADY_EXISTS */) {
        // Lost the race to a concurrent request that committed first, that request's write is
        // the real registration, this one is a no-op duplicate. Nothing further to look up
        // since the response never includes ref/duplicate details either way.
        return res.json({ success: true });
      }
      throw e;
    }

    // AiSensy welcome message (wtl_welcome_referral) intentionally not sent here yet.
    // services/aisensy.js only exposes sendBroadcast(), a mass campaign broadcast to
    // "all" contacts, not a single-recipient templated send. A real per-founder welcome
    // message needs a proper AiSensy template-send call (phone + template name + variables),
    // which shouldn't be guessed blind against a live API key. Build and test that separately.

    res.json({ success: true });
  } catch (err) {
    // Log full details server-side only, never leak Firestore/internal errors to the public internet.
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again in a moment.' });
  }
});

module.exports = router;
