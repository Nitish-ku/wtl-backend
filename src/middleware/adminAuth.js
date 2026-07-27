const { getAuth } = require('../services/firestore');

const ROOT_ADMINS = ['founder@wiredtolaunch.in'];
const CO_ADMINS = [];

async function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    const email = decoded.email;
    if (ROOT_ADMINS.includes(email)) {
      req.user = { uid: decoded.uid, email, role: 'root' };
      return next();
    }
    if (CO_ADMINS.includes(email)) {
      req.user = { uid: decoded.uid, email, role: 'coadmin' };
      return next();
    }
    return res.status(403).json({ error: 'Forbidden — admin access required' });
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized — invalid token' });
  }
}

function rootOnlyMiddleware(req, res, next) {
  if (req.user?.role !== 'root') {
    return res.status(403).json({ error: 'Forbidden — root access required' });
  }
  next();
}

module.exports = { adminAuthMiddleware, rootOnlyMiddleware };
