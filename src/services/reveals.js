const { getDb, saveRevealSnapshot, admin } = require('./firestore');
const { sendBroadcast } = require('./aisensy');

const REVEAL_DURATION_MINS = 30;

function getNextRevealTime() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const reveal = new Date(istNow);
  reveal.setHours(20, 30, 0, 0);
  if (istNow > reveal) reveal.setDate(reveal.getDate() + 1);
  return new Date(reveal.getTime() - istOffset);
}

function getRevealStatus(revealData) {
  if (!revealData) return { status: 'countdown', nextReveal: getNextRevealTime() };
  const now = new Date();
  const revealTime = revealData.triggeredAt?.toDate() || new Date(0);
  const revealEnd = new Date(revealTime.getTime() + REVEAL_DURATION_MINS * 60 * 1000);
  if (now < revealTime) return { status: revealData.isFlash ? 'flash_pending' : 'countdown', nextReveal: revealTime, flashMessage: revealData.flashMessage || null };
  if (now >= revealTime && now < revealEnd) return { status: 'live', revealEnd, leaderboard: revealData.leaderboard || [], day: revealData.day };
  return { status: 'closed', nextReveal: getNextRevealTime(), lastLeaderboard: revealData.leaderboard || [] };
}

async function triggerReveal(cohortId, day, options = {}) {
  const { isFlash = false, flashMessage = '', triggeredBy = 'system' } = options;
  const db = getDb();
  const leaderboard = await saveRevealSnapshot(cohortId, day);
  await db.collection('reveals').doc(cohortId).set({
    status: 'live', triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
    triggeredBy, isFlash, flashMessage, day, leaderboard,
    revealEnd: new Date(Date.now() + REVEAL_DURATION_MINS * 60 * 1000),
  }, { merge: true });
  if (triggeredBy !== 'system') {
    await db.collection('adminLogs').add({ action: isFlash ? 'flash_reveal' : 'manual_reveal', triggeredBy, flashMessage, cohortId, day, timestamp: admin.firestore.FieldValue.serverTimestamp() });
  }
  const msg = isFlash
    ? `🚨 FLASH SCOREBOARD DROP\n\nFelicia just called an early reveal.\n${flashMessage}\n\nOpen your dashboard NOW.\nwiredtolaunch.in/sprint`
    : `🏆 DAY ${day} STANDINGS ARE LIVE\n\n#1 ${leaderboard[0]?.name || '—'} — ${leaderboard[0]?.totalScore || 0} pts 🔥\n#2 ${leaderboard[1]?.name || '—'} — ${leaderboard[1]?.totalScore || 0} pts\n\n09:00 PM — Night Build Shift in 30 mins.\n\nwiredtolaunch.in/sprint`;
  await sendBroadcast(msg).catch(console.error);
  return { success: true, leaderboard };
}

async function detectCloseRaces(cohortId) {
  const { getLeaderboard } = require('./firestore');
  const leaderboard = await getLeaderboard(cohortId, 10);
  const closeRaces = [];
  for (let i = 0; i < leaderboard.length - 1; i++) {
    const gap = leaderboard[i].totalScore - leaderboard[i + 1].totalScore;
    if (gap <= 50) closeRaces.push({ triad1: leaderboard[i].name, triad2: leaderboard[i + 1].name, gap, rank1: i + 1, rank2: i + 2 });
  }
  return closeRaces;
}

module.exports = { getNextRevealTime, getRevealStatus, triggerReveal, detectCloseRaces };
