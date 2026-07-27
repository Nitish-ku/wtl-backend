const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { adminAuthMiddleware } = require('../middleware/adminAuth');
const { getDb, getRevealSnapshot } = require('../services/firestore');
const { getRevealStatus, triggerReveal, detectCloseRaces } = require('../services/reveals');

router.get('/status', authMiddleware, async (req, res) => {
  const { cohortId } = req.query;
  if (!cohortId) return res.status(400).json({ error: 'Missing cohortId' });
  try {
    const revealDoc = await getDb().collection('reveals').doc(cohortId).get();
    const revealData = revealDoc.exists ? revealDoc.data() : null;
    const status = getRevealStatus(revealData);
    if (status.status !== 'live') delete status.leaderboard;
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/snapshot', authMiddleware, async (req, res) => {
  const { cohortId, day } = req.query;
  if (!cohortId || !day) return res.status(400).json({ error: 'Missing params' });
  try {
    const snapshot = await getRevealSnapshot(cohortId, parseInt(day));
    if (!snapshot) return res.status(404).json({ error: 'No snapshot for this day' });
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/trigger', adminAuthMiddleware, async (req, res) => {
  const { cohortId, day, isFlash, flashMessage } = req.body;
  if (!cohortId || !day) return res.status(400).json({ error: 'Missing cohortId or day' });
  try {
    const result = await triggerReveal(cohortId, day, { isFlash: isFlash || false, flashMessage: flashMessage || '', triggeredBy: req.user.email });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/close-races', adminAuthMiddleware, async (req, res) => {
  const { cohortId } = req.query;
  if (!cohortId) return res.status(400).json({ error: 'Missing cohortId' });
  try {
    const closeRaces = await detectCloseRaces(cohortId);
    res.json({ closeRaces });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
