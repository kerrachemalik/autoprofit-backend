const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth");

module.exports = (pool) => {
  // Mon profil (utilisateur connecté)
  router.get("/me", requireAuth, async (req, res) => {
    const result = await pool.query(
      "SELECT email, is_premium, analyses_count, created_at FROM users WHERE email = $1",
      [req.userEmail]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Compte introuvable." });
    res.json(result.rows[0]);
  });

  // Admin uniquement : liste de tous les utilisateurs inscrits
  router.get("/", requireAuth, requireAdmin, async (req, res) => {
    const result = await pool.query(
      "SELECT email, is_premium, analyses_count, created_at FROM users ORDER BY created_at DESC"
    );
    res.json(result.rows);
  });

  return router;
};
