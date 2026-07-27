const https = require('https');

async function sendBroadcast(message) {
  const apiKey = process.env.AISENSY_API_KEY;
  if (!apiKey) { console.warn('AiSensy not configured'); return { skipped: true }; }

  const payload = JSON.stringify({
    apiKey,
    campaignName: process.env.AISENSY_CAMPAIGN || 'WTL_Sprint_Reveal',
    destination: 'all',
    userName: 'Wired To Launch',
    templateParams: [message],
    source: 'api',
    media: {},
    buttons: [],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'backend.aisensy.com',
      path: '/campaign/t1/api/v2',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { sendBroadcast };
