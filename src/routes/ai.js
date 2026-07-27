const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { generateContent } = require('../services/vertexai');
const { addScoreEvent } = require('../services/firestore');

router.use(authMiddleware);

const JSON_MODULES = ['extraction', 'validator'];

const SYSTEM_PROMPTS = {
  extraction: process.env.GEMINI_PROMPT_IDEATION_FILTER || 'You are the WiredToLaunch Ideation Filter for ADHD founders in India. Analyze the audit inputs and return up to 5 business ideas as valid JSON only. No preamble. Use this exact structure: {"ideas":[{"rank":1,"idea_name":"string","idea_summary":"string","why_shortlisted":"string","audience":"string"}]}',
  validator: process.env.GEMINI_PROMPT_IDEA_VALIDATOR || 'You are the WiredToLaunch Idea Validator for ADHD founders in India. Score the idea and return a verdict as valid JSON only. No preamble. Use this exact structure: {"scores":{"market_reality":0,"founder_fit":0,"revenue_speed":0,"execution_simplicity":0,"india_market_fit":0},"total":0,"verdict":"GO","verdict_justification":"string","unfair_advantage":"string","biggest_risk":"string","action_step_24h":"string"}',
  outreach: process.env.GEMINI_PROMPT_OUTREACH_BUILDER || 'You are the WiredToLaunch Outreach Builder. Write one copy-paste ready outreach message for ADHD founders in India. Output the message text ONLY. Max 100 words. Human tone. Indian Rupee pricing. One frictionless CTA.',
  copygen: process.env.GEMINI_PROMPT_SALES_COPY_GENERATOR || 'You are the WiredToLaunch Sales Copy Generator. Write punchy human copy for Indian ADHD founders. Output ONLY the copy in three blocks separated by ---BLOCK--- : Hook (2-3 sentences), Transformation (3-4 sentences), CTA with UPI payment instruction (1-2 sentences).',
};

function buildUserPrompt(module, data) {
  switch (module) {
    case 'extraction':
      return 'Founder audit responses:\nAudit 1 - Saved Screenshots: ' + (data.audit1 || 'not provided') + '\nAudit 2 - YouTube Watch History: ' + (data.audit2 || 'not provided') + '\nAudit 3 - Pinterest/Instagram Saves: ' + (data.audit3 || 'not provided') + '\nAudit 4 - WhatsApp Chats: ' + (data.audit4 || 'not provided') + '\nAudit 5 - Contacts to Message: ' + (data.audit5 || 'not provided') + '\nAudit 6 - 1-star Reviews in Industry: ' + (data.audit6 || 'not provided') + '\n\nAnalyze for a 72-hour solo build in the Indian market. Return JSON shortlist.';
    case 'validator':
      return 'Idea: ' + data.name + '\nDescription: ' + (data.description || 'not provided') + '\nAudience: ' + (data.audience || 'not provided') + '\nScores: Pain=' + data.pain + ', Speed=' + data.speed + ', WTP=' + data.pay + ', Energy=' + data.energy + ', Distribution=' + data.reach + '\nTotal: ' + data.total + '/25\n\nScore each dimension out of 20 and return JSON verdict.';
    case 'outreach':
      return 'Write a ' + data.type + ' with ' + data.tone + ' tone.\nProduct: ' + data.product + '\nAudience: ' + (data.audience || 'ADHD founders India') + '\nRecipient detail: ' + (data.recipient_detail || 'not provided') + '\nChannel: ' + (data.channel || 'WhatsApp') + (data.regen ? '\nWrite a completely different angle.' : '\nMake it immediately sendable.');
    case 'copygen':
      return 'Idea: ' + data.idea + '\nAudience: ' + data.audience + '\nPrice: ' + data.price + '\nChannel: ' + (data.channel || 'WhatsApp') + '\n\nWrite three blocks separated by ---BLOCK---';
    default:
      return data.prompt || '';
  }
}

function parseJsonResponse(text, module) {
  var cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return { parsed: JSON.parse(cleaned), raw: null };
  } catch (e) {
    console.error('JSON parse failed for module ' + module + ': ' + e.message);
    return { parsed: null, raw: cleaned };
  }
}

router.post('/generate', async (req, res) => {
  var module = req.body.module;
  var cohortId = req.body.cohortId;
  var day = req.body.day;
  var data = req.body.data;
  var uid = req.user.uid;
  if (!module || !data) return res.status(400).json({ error: 'Missing module or data' });
  var systemPrompt = SYSTEM_PROMPTS[module];
  if (!systemPrompt) return res.status(400).json({ error: 'Unknown module: ' + module });
  try {
    var userPrompt = buildUserPrompt(module, data);
    var text = await generateContent(systemPrompt, userPrompt);
    if (cohortId && uid) {
      var pts = module === 'extraction' ? 50 : 30;
      await addScoreEvent(cohortId, uid, pts, module + '_generated', day || 1).catch(console.error);
    }
    if (JSON_MODULES.includes(module)) {
      var result = parseJsonResponse(text, module);
      if (result.parsed) return res.json({ data: result.parsed });
      return res.json({ data: null, raw: result.raw, parse_error: true });
    }
    if (module === 'copygen') {
      var blocks = text.split('---BLOCK---').map(function(b) { return b.trim(); }).filter(Boolean);
      return res.json({ data: { hook: blocks[0] || '', transformation: blocks[1] || '', cta: blocks[2] || '' } });
    }
    return res.json({ data: { message: text } });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
