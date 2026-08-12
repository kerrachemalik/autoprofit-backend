const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth");

module.exports = (pool) => {
  // Envoyer un message de support (n'importe quel utilisateur connecté)
  router.post("/", requireAuth, async (req, res) => {
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();
    if (!subject || !message) return res.status(400).json({ error: "Objet et message requis." });
    const result = await pool.query(
      "INSERT INTO messages (from_email, subject, message) VALUES ($1, $2, $3) RETURNING *",
      [req.userEmail, subject, message]
    );
    res.json(result.rows[0]);
  });

  // Admin uniquement : boîte de réception complète
  router.get("/", requireAuth, requireAdmin, async (req, res) => {
    const result = await pool.query("SELECT * FROM messages ORDER BY created_at DESC");
    res.json(result.rows);
  });

  // Admin uniquement : marquer un message comme lu
  router.patch("/:id/read", requireAuth, requireAdmin, async (req, res) => {
    await pool.query("UPDATE messages SET is_read = true WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  return router;
};
