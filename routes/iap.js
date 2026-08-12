const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");

// Vérifie un reçu d'achat Apple In-App Purchase et active Premium si valide.
// Voir ios-storekit/IAP_SETUP.md pour la partie côté app (Xcode/StoreKit) qui
// appelle cette route après un achat réussi.
module.exports = (pool) => {
  router.post("/verify-receipt", requireAuth, async (req, res) => {
    const { receiptData } = req.body;
    if (!receiptData) return res.status(400).json({ error: "Reçu manquant." });
    if (!process.env.APPLE_SHARED_SECRET) {
      return res.status(500).json({ error: "APPLE_SHARED_SECRET non configuré côté serveur." });
    }

    // Apple recommande d'appeler d'abord l'environnement de production, puis
    // de retomber sur le sandbox si Apple répond "reçu de test" (code 21007).
    const verify = async (url) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "receipt-data": receiptData,
          password: process.env.APPLE_SHARED_SECRET,
        }),
      });
      return r.json();
    };

    let result = await verify("https://buy.itunes.apple.com/verifyReceipt");
    if (result.status === 21007) {
      result = await verify("https://sandbox.itunes.apple.com/verifyReceipt");
    }

    const isValid = result.status === 0;
    if (!isValid) return res.status(400).json({ error: "Reçu invalide.", appleStatus: result.status });

    await pool.query("UPDATE users SET is_premium = true WHERE email = $1", [req.userEmail]);
    res.json({ success: true, isPremium: true });
  });

  return router;
};
