const express = require('express');
const router = express.Router();
const { adminAuthMiddleware, rootOnlyMiddleware } = require('../middleware/adminAuth');
const { getDb, getLeaderboard, addScoreEvent, admin } = require('../services/firestore');

router.use(adminAuthMiddleware);

router.get('/dashboard', async (req, res) => {
  const { cohortId } = req.query;
  if (!cohortId) return res.status(400).json({ error: 'Missing cohortId' });
  try {
    const db = getDb();
    const triadsSnap = await db.collection('cohorts').doc(cohortId).collection('triads').orderBy('totalScore', 'desc').get();
    const triads = triadsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const scoresSnap = await db.collection('cohorts').doc(cohortId).collection('scores').get();
    const totalFounders = scoresSnap.size;
    const avgScore = totalFounders > 0 ? Math.round(scoresSnap.docs.reduce((sum, d) => sum + (d.data().personalScore || 0), 0) / totalFounders) : 0;
    const closeRaces = [];
    for (let i = 0; i < Math.min(triads.length - 1, 5); i++) {
      const gap = triads[i].totalScore - triads[i+1].totalScore;
      if (gap <= 100) closeRaces.push({ triad1: triads[i].name || triads[i].id, triad2: triads[i+1].name || triads[i+1].id, gap, score1: triads[i].totalScore, score2: triads[i+1].totalScore });
    }
    const logsSnap = await db.collection('adminLogs').where('cohortId', '==', cohortId).orderBy('timestamp', 'desc').limit(20).get();
    res.json({ cohortId, totalTriads: triads.length, totalFounders, avgScore, topTriad: triads[0] || null, leaderboard: triads.slice(0, 10), closeRaces, logs: logsSnap.docs.map(d => ({ id: d.id, ...d.data() })), adminRole: req.user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/score-adjust', async (req, res) => {
  const { cohortId, uid, pts, reason, day } = req.body;
  if (!cohortId || !uid || pts === undefined || !reason) return res.status(400).json({ error: 'Missing required fields' });
  try {
    await addScoreEvent(cohortId, uid, pts, 'manual_adjustment', day || 1);
    await getDb().collection('adminLogs').add({ action: 'score_adjustment', performedBy: req.user.email, performedByRole: req.user.role, cohortId, uid, pts, reason, day, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, message: `${pts > 0 ? '+' : ''}${pts} pts applied` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create-cohort', rootOnlyMiddleware, async (req, res) => {
  const { cohortId, name, scalingPrice } = req.body;
  try {
    await getDb().collection('cohorts').doc(cohortId).set({ id: cohortId, name: name || `Cohort ${cohortId}`, scalingPrice: scalingPrice || 2999, status: 'active', createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: req.user.email });
    res.json({ success: true, cohortId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs', async (req, res) => {
  const { cohortId, limit = 50 } = req.query;
  try {
    let query = getDb().collection('adminLogs').orderBy('timestamp', 'desc').limit(parseInt(limit));
    if (cohortId) query = query.where('cohortId', '==', cohortId);
    const snap = await query.get();
    res.json({ logs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
