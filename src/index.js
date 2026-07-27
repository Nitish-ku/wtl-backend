const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const { initFirebase } = require('./services/firestore');
const aiRoutes = require('./routes/ai');
const scoresRoutes = require('./routes/scores');
const revealsRoutes = require('./routes/reveals');
const adminRoutes = require('./routes/admin');
const registerRoutes = require('./routes/register');

const app = express();
const PORT = process.env.PORT || 8080;

// Cloud Run sits behind Google's front-end proxy, which sets X-Forwarded-For.
// Trust that one hop so req.ip reflects the real client IP (used by the
// register route's per-IP rate limiter) instead of the proxy's address.
app.set('trust proxy', 1);

const ALLOWED_ORIGINS = [
  'https://wiredtolaunch.in',
  'https://www.wiredtolaunch.in',
  'https://wiredtolaunch.pages.dev',
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
  'https://launchbrained.live',
  'https://www.launchbrained.live',
  'https://onelaunchaway.live',
  'https://www.onelaunchaway.live',
  'https://sprintandlaunch.live',
  'https://www.sprintandlaunch.live',
  'https://theadhdfounders.live',
  'https://www.theadhdfounders.live',
  'https://wiredtolaunch.live',
  'https://www.wiredtolaunch.live',
];

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || (origin.startsWith('https://') && origin.endsWith('.wiredtolaunch.pages.dev'))) {
      callback(null, true);
    } else {
      const err = new Error('Not allowed by CORS');
      err.status = 403;
      callback(err);
    }
  },
  credentials: true,
}));
// Tighter body-size limit scoped to registration: it only ever accepts a small JSON object,
// not the app-wide 10mb default meant for other routes. This has to be mounted BEFORE the
// app-wide express.json() below, body-parser no-ops (skips re-parsing/re-limiting) once
// req._body has already been set by an earlier json() call on the same request.
app.use('/api/register', express.json({ limit: '32kb' }));
app.use(express.json({ limit: '10mb' }));

initFirebase();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/ai', aiRoutes);
app.use('/api/scores', scoresRoutes);
app.use('/api/reveals', revealsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/register', registerRoutes);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  console.error(err.stack);
  res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Wired To Launch backend running on port ${PORT}`);
});

module.exports = app;
