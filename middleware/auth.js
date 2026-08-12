const jwt = require("jsonwebtoken");

// Vérifie qu'un jeton JWT valide est présent (utilisateur connecté)
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifié." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: "Session invalide ou expirée." });
  }
}

// Vérifie que l'utilisateur connecté est l'unique compte admin
function requireAdmin(req, res, next) {
  if (req.userEmail !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: "Accès réservé à l'administrateur." });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
