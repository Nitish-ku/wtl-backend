const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { addScoreEvent, getFounderScore, getDb, admin } = require('../services/firestore');

router.use(authMiddleware);

const DAY_MAX = { 1: 530, 2: 430, 3: 2110 };

const ACTION_POINTS = {
  audit_complete: 25, audit_all_bonus: 50, filter_run: 50,
  validator_run: 30, go_verdict: 100, sharpen_verdict: 50,
  price_calc: 40, price_lock: 25, copy_gen: 50,
  copy_block: 25, copy_all_bonus: 75,
  script_gen: 30, script_sent: 50, scripts_5_bonus: 100,
  inputs_10_bonus: 100, inputs_20_bonus: 200, inputs_30_bonus: 300,
  timer_complete: 40, reset_message: 20, reset_voice: 30,
  reset_call: 40, reset_bodydouble: 50, reset_public_credit: 100,
  triad_confirm: 25, body_double_session: 75,
  triad_feedback: 50, triad_repost: 60,
  triad_day1_all: 150, triad_day2_all: 150, triad_day3_all: 200,
};

function getActionsForGap(gap, day) {
  const actions = [];
  if (day === 1) {
    if (gap >= 25) actions.push(`${Math.ceil(gap/25)} more source audit${Math.ceil(gap/25)>1?'s':''} = ${Math.ceil(gap/25)*25} pts`);
    if (gap >= 50) actions.push('Run the ideation filter = 50 pts');
    if (gap >= 30) actions.push('Complete the validator = 30 pts');
  } else if (day === 2) {
    if (gap >= 40) actions.push('Run the price calculator = 40 pts');
    if (gap >= 50) actions.push('Generate sales copy = 50 pts');
    if (gap >= 75) actions.push('Copy all 3 blocks = 75 pts bonus');
  } else if (day === 3) {
    if (gap >= 50) actions.push(`${Math.ceil(gap/50)} outreach inputs = ${Math.ceil(gap/50)*50} pts`);
    if (gap >= 40) actions.push('Complete a 25-min timer sprint = 40 pts');
    if (gap >= 75) actions.push('Log a body doubling session = 75 pts');
  }
  return actions.slice(0, 3);
}

router.post('/event', async (req, res) => {
  const { cohortId, action, day } = req.body;
  const uid = req.user.uid;
  if (!cohortId || !action) return res.status(400).json({ error: 'Missing cohortId or action' });
  const pts = ACTION_POINTS[action];
  if (pts === undefined) return res.status(400).json({ error: `Unknown action: ${action}` });
  try {
    await addScoreEvent(cohortId, uid, pts, action, day || 1);
    const score = await getFounderScore(cohortId, uid);
    const discount = Math.min(Math.floor(score.personalScore / 10), 500);
    res.json({ success: true, pts, personalScore: score.personalScore, dayScores: score.dayScores, discount, finalPrice: 2999 - discount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', async (req, res) => {
  const { cohortId } = req.query;
  const uid = req.user.uid;
  if (!cohortId) return res.status(400).json({ error: 'Missing cohortId' });
  try {
    const score = await getFounderScore(cohortId, uid);
    const discount = Math.min(Math.floor(score.personalScore / 10), 500);
    const nudges = {};
    for (const day of [1, 2, 3]) {
      const dayScore = (score.dayScores || {})[`day${day}`] || 0;
      const gap = DAY_MAX[day] - dayScore;
      nudges[`day${day}`] = { captured: dayScore, possible: DAY_MAX[day], pct: Math.round(dayScore/DAY_MAX[day]*100), gap, actions: getActionsForGap(gap, day) };
    }
    res.json({ personalScore: score.personalScore, dayScores: score.dayScores, triadId: score.triadId, discount, finalPrice: 2999 - discount, nudges });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/join-triad', async (req, res) => {
  const { cohortId, triadCode } = req.body;
  const uid = req.user.uid;
  if (!cohortId || !triadCode) return res.status(400).json({ error: 'Missing cohortId or triadCode' });
  try {
    const db = getDb();
    const triadId = triadCode.toUpperCase();
    const triadRef = db.collection('cohorts').doc(cohortId).collection('triads').doc(triadId);
    const triadDoc = await triadRef.get();
    if (!triadDoc.exists) {
      await triadRef.set({ id: triadId, name: triadId, totalScore: 0, memberCount: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    const members = await db.collection('cohorts').doc(cohortId).collection('scores').where('triadId', '==', triadId).get();
    if (members.size >= 3) return res.status(400).json({ error: 'Triad is full (max 3 members)' });
    const scoreRef = db.collection('cohorts').doc(cohortId).collection('scores').doc(uid);
    await scoreRef.set({ triadId }, { merge: true });
    await triadRef.update({ memberCount: admin.firestore.FieldValue.increment(1) });
    res.json({ success: true, triadId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
