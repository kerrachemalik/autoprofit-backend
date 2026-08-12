const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const router = express.Router();

// Limite les tentatives de connexion/inscription pour freiner le brute-force
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

function signToken(email) {
  return jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

module.exports = (pool) => {
  // Inscription
  router.post("/signup", authLimiter, async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || password.length < 6) {
      return res.status(400).json({ error: "E-mail invalide ou mot de passe trop court (6 caractères min)." });
    }
    const existing = await pool.query("SELECT email FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Un compte existe déjà avec cet e-mail." });
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2)", [email, hash]);
    const token = signToken(email);
    res.json({ token, email, isPremium: false, isAdmin: email === process.env.ADMIN_EMAIL });
  });

  // Connexion
  router.post("/login", authLimiter, async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
    }
    const token = signToken(email);
    res.json({ token, email, isPremium: user.is_premium, isAdmin: email === process.env.ADMIN_EMAIL });
  });

  // Réinitialisation de mot de passe
  // NOTE : ceci change directement le mot de passe après vérification de l'email.
  // Pour une vraie sécurité "mot de passe oublié", il faut ajouter l'envoi d'un
  // e-mail contenant un lien à usage unique (ex: via Resend, SendGrid, ou le
  // service d'e-mail intégré de Supabase Auth) avant d'autoriser ce changement.
  router.post("/reset-password", authLimiter, async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const newPassword = String(req.body.newPassword || "");
    if (newPassword.length < 6) return res.status(400).json({ error: "Mot de passe trop court." });
    const existing = await pool.query("SELECT email FROM users WHERE email = $1", [email]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Aucun compte trouvé avec cet e-mail." });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1 WHERE email = $2", [hash, email]);
    res.json({ success: true });
  });

  return router;
};
