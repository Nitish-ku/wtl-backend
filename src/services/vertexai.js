const { GoogleGenerativeAI } = require('@google/generative-ai');

let model;

function initGemini() {
  if (model) return;
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  console.log('Gemini API initialized');
}

async function generateContent(systemPrompt, userPrompt) {
  initGemini();
  const result = await model.generateContent({
    systemInstruction: systemPrompt,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
  });
  const text = result.response.text();
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

module.exports = { generateContent };
