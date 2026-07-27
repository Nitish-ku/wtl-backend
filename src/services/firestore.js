const admin = require('firebase-admin');

let db, storage, auth;

function initFirebase() {
  if (admin.apps.length > 0) return;
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'wiredtolaunch.firebasestorage.app',
  });
  db = admin.firestore();
  storage = admin.storage();
  auth = admin.auth();
  console.log('Firebase Admin initialized');
}

function getDb() { if (!db) throw new Error('Firebase not initialized'); return db; }
function getStorage() { if (!storage) throw new Error('Firebase not initialized'); return storage; }
function getAuth() { if (!auth) throw new Error('Firebase not initialized'); return auth; }

async function getFounderScore(cohortId, uid) {
  const ref = getDb().collection('cohorts').doc(cohortId).collection('scores').doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({ uid, personalScore: 0, dayScores: { day1: 0, day2: 0, day3: 0 }, triadId: null, actions: [], createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return (await ref.get()).data();
  }
  return doc.data();
}

async function addScoreEvent(cohortId, uid, pts, action, day) {
  const db = getDb();
  const scoreRef = db.collection('cohorts').doc(cohortId).collection('scores').doc(uid);
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(scoreRef);
    const data = doc.exists ? doc.data() : { personalScore: 0, dayScores: { day1: 0, day2: 0, day3: 0 }, actions: [], triadId: null };
    const dayKey = `day${day}`;
    const newPersonalScore = (data.personalScore || 0) + pts;
    const newDayScore = ((data.dayScores || {})[dayKey] || 0) + pts;
    transaction.set(scoreRef, {
      ...data,
      personalScore: newPersonalScore,
      dayScores: { ...(data.dayScores || {}), [dayKey]: newDayScore },
      actions: admin.firestore.FieldValue.arrayUnion({ action, pts, day, timestamp: Date.now() }),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (data.triadId) {
      const triadRef = db.collection('cohorts').doc(cohortId).collection('triads').doc(data.triadId);
      transaction.update(triadRef, { totalScore: admin.firestore.FieldValue.increment(pts), lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
    }
  });
}

async function getLeaderboard(cohortId, limit = 10) {
  const snapshot = await getDb().collection('cohorts').doc(cohortId).collection('triads').orderBy('totalScore', 'desc').limit(limit).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function saveRevealSnapshot(cohortId, day) {
  const leaderboard = await getLeaderboard(cohortId, 20);
  const ref = getDb().collection('reveals').doc(cohortId).collection('days').doc(`day${day}`);
  await ref.set({ leaderboard, timestamp: admin.firestore.FieldValue.serverTimestamp(), day });
  return leaderboard;
}

async function getRevealSnapshot(cohortId, day) {
  const ref = getDb().collection('reveals').doc(cohortId).collection('days').doc(`day${day}`);
  const doc = await ref.get();
  return doc.exists ? doc.data() : null;
}

module.exports = { initFirebase, getDb, getStorage, getAuth, getFounderScore, addScoreEvent, getLeaderboard, saveRevealSnapshot, getRevealSnapshot, admin };
