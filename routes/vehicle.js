const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");

const FREE_WEEKLY_LIMIT = 3;

// Décode les entités XML de base (&quot; &amp; &lt; &gt; &#39;) présentes dans
// la réponse SOAP/ASMX de RegCheck avant de parser le JSON qu'elle contient.
function decodeXmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

module.exports = (pool) => {
  // Identifie un véhicule à partir d'une plaque française via RegCheck.org.uk
  // (même fournisseur qu'ImmatriculationAPI.com). VEHICLE_API_KEY doit contenir
  // le "username" du compte RegCheck (pas une clé au sens strict).
  router.post("/lookup", requireAuth, async (req, res) => {
    const { plate } = req.body;
    if (!plate) return res.status(400).json({ error: "Plaque ou VIN requis." });

    if (process.env.VEHICLE_API_KEY) {
      try {
        const cleanPlate = plate.replace(/[\s-]/g, "").toUpperCase();
        const url = `https://www.regcheck.org.uk/api/reg.asmx/CheckFrance?RegistrationNumber=${encodeURIComponent(cleanPlate)}&username=${encodeURIComponent(process.env.VEHICLE_API_KEY)}`;
        const providerRes = await fetch(url);
        const xml = await providerRes.text();
        const match = xml.match(/<vehicleJson>([\s\S]*?)<\/vehicleJson>/);
        if (!match) throw new Error("Format de réponse inattendu du fournisseur.");
        const vehicleData = JSON.parse(decodeXmlEntities(match[1]));
        return res.json({ isDemo: false, plate: cleanPlate, ...vehicleData });
      } catch (e) {
        console.error("Erreur API plaque (RegCheck) :", e.message);
        // On retombe sur la démonstration plutôt que de bloquer l'utilisateur
      }
    }

    // Fallback démonstration tant qu'aucun fournisseur n'est configuré (ou en cas d'échec)
    return res.json({
      isDemo: true,
      message: "Aucun fournisseur réel configuré (VEHICLE_API_KEY manquante) — réponse de démonstration.",
    });
  });

  // Calcule le prix de marché pour un véhicule donné.
  // Branche ici ta base de comparables ou un fournisseur de cote licencié.
  router.post("/market", requireAuth, async (req, res) => {
    if (process.env.MARKET_DATA_API_KEY) {
      // TODO : remplacer par le vrai appel à ton fournisseur de cote
    }
    return res.json({
      isDemo: true,
      message: "Aucun fournisseur de données de marché configuré — réponse de démonstration.",
    });
  });

  // Enregistre une analyse : vérifie le quota gratuit (3/semaine), incrémente le compteur.
  router.post("/analyses", requireAuth, async (req, res) => {
    const userResult = await pool.query("SELECT is_premium FROM users WHERE email = $1", [req.userEmail]);
    const isPremium = userResult.rows[0]?.is_premium;

    if (!isPremium) {
      const countResult = await pool.query(
        "SELECT COUNT(*) FROM analyses WHERE user_email = $1 AND created_at > now() - interval '7 days'",
        [req.userEmail]
      );
      const usedThisWeek = parseInt(countResult.rows[0].count, 10);
      if (usedThisWeek >= FREE_WEEKLY_LIMIT) {
        return res.status(403).json({ error: "Quota gratuit atteint (3 analyses/semaine). Passe Premium pour continuer." });
      }
    }

    const { vehicleName, plate, purchasePrice, margin, score, verdict } = req.body;
    const result = await pool.query(
      `INSERT INTO analyses (user_email, vehicle_name, plate, purchase_price, margin, score, verdict)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userEmail, vehicleName, plate, purchasePrice, margin, score, verdict]
    );
    await pool.query("UPDATE users SET analyses_count = analyses_count + 1 WHERE email = $1", [req.userEmail]);
    res.json(result.rows[0]);
  });

  // Historique des analyses de l'utilisateur connecté
  router.get("/analyses", requireAuth, async (req, res) => {
    const result = await pool.query(
      "SELECT * FROM analyses WHERE user_email = $1 ORDER BY created_at DESC",
      [req.userEmail]
    );
    res.json(result.rows);
  });

  return router;
};
