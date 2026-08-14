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

// Un VIN fait 17 caractères et ne contient jamais I, O ou Q (norme ISO 3779)
function isVin(value) {
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(value.replace(/\s/g, ""));
}

// Décode un VIN via l'API officielle NHTSA (gratuite, sans clé, sans inscription).
async function decodeVin(vin) {
  const cleanVin = vin.replace(/\s/g, "").toUpperCase();
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(cleanVin)}?format=json`;
  const providerRes = await fetch(url);
  const data = await providerRes.json();
  const r = data.Results && data.Results[0];
  if (!r || !r.Make) throw new Error("VIN non reconnu par la base NHTSA.");
  return {
    isDemo: false,
    vin: cleanVin,
    marque: r.Make,
    modele: r.Model,
    annee: r.ModelYear,
    carburant: r.FuelTypePrimary,
    cylindree: r.DisplacementL,
    cylindres: r.EngineCylinders,
    boite: r.TransmissionStyle,
    carrosserie: r.BodyClass,
    portes: r.Doors,
    puissanceCh: r.EngineHP,
  };
}

const CACHE_VALIDITY_DAYS = 14;

// Calcule médiane, moyenne, min/max et un score de confiance
function computeMarketStats(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const mean = sorted.reduce((sum, p) => sum + p, 0) / n;
  const min = sorted[0];
  const max = sorted[n - 1];
  const confidence = n >= 20 ? "élevée" : n >= 8 ? "moyenne" : "faible";
  return {
    median: Math.round(median),
    mean: Math.round(mean),
    min: Math.round(min),
    max: Math.round(max),
    comparablesCount: n,
    confidence,
  };
}

module.exports = (pool) => {
  // Identifie un véhicule à partir d'une plaque française ou d'un VIN
  router.post("/lookup", requireAuth, async (req, res) => {
    const { plate } = req.body;
    if (!plate) return res.status(400).json({ error: "Plaque ou VIN requis." });

    if (isVin(plate)) {
      try {
        const vehicleData = await decodeVin(plate);
        return res.json(vehicleData);
      } catch (e) {
        console.error("Erreur décodage VIN (NHTSA) :", e.message);
      }
    } else if (process.env.VEHICLE_API_KEY) {
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
      }
    }

    return res.json({
      isDemo: true,
      message: "Aucun fournisseur réel configuré ou VIN non reconnu — réponse de démonstration.",
    });
  });

  // Prix du marché — Appel direct à Apify (clearpath/leboncoin-api) via Render
  router.post("/market", requireAuth, async (req, res) => {
    const { brand, model, year, km, fuel } = req.body;
    if (!brand || !model || !year) {
      return res.status(400).json({ error: "Marque, modèle et année requis." });
    }

    // 1. Vérification dans le cache PostgreSQL local
    try {
      const cached = await pool.query(
        `SELECT * FROM market_prices_cache
         WHERE brand = $1 AND model = $2 AND year = $3
           AND created_at > now() - interval '${CACHE_VALIDITY_DAYS} days'
         ORDER BY created_at DESC LIMIT 1`,
        [brand, model, year]
      );
      if (cached.rows[0]) {
        const c = cached.rows[0];
        return res.json({
          isDemo: false,
          fromCache: true,
          median: Number(c.median_price),
          mean: Number(c.mean_price),
          min: Number(c.min_price),
          max: Number(c.max_price),
          comparablesCount: c.comparables_count,
          source: c.source,
        });
      }
    } catch (e) {
      console.error("Erreur lecture cache marché :", e.message);
    }

    // 2. Appel direct à Apify via Render (clearpath/leboncoin-api)
    try {
      const apifyToken = process.env.MARKET_DATA_API_KEY;
      if (!apifyToken) {
        throw new Error("Clé MARKET_DATA_API_KEY absente sur Render.");
      }

      const apifyActorId = "clearpath/leboncoin-api";
      const apifyUrl = `https://api.apify.com/v2/acts/${apifyActorId}/run-sync-get-dataset-items?token=${apifyToken}`;

      const response = await fetch(apifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `${brand} ${model} ${year}`.trim(),
          category: "voitures",
          maxItems: 20
        })
      });

      const items = await response.json();

      if (Array.isArray(items) && items.length > 0) {
        // Extraction des prix réels retournés par LeBonCoin via Apify
        const prices = items
          .map((item) => parseFloat(item.price || item.prix || (item.priceCents ? item.priceCents / 100 : null)))
          .filter((price) => !isNaN(price) && price > 0);

        const stats = computeMarketStats(prices);

        if (stats) {
          // Sauvegarde dans le cache local PostgreSQL
          try {
            await pool.query(
              `INSERT INTO market_prices_cache (brand, model, year, median_price, mean_price, min_price, max_price, comparables_count, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'apify-direct')`,
              [brand, model, year, stats.median, stats.mean, stats.min, stats.max, stats.comparablesCount]
            );
          } catch (cacheErr) {
            console.error("Erreur écriture cache :", cacheErr.message);
          }

          return res.json({
            isDemo: false,
            fromCache: false,
            ...stats,
            source: "apify-direct",
          });
        }
      }
    } catch (e) {
      console.error("Erreur appel Apify direct sur Render :", e.message);
    }

    return res.status(500).json({
      isDemo: false,
      error: "Impossible de récupérer les données du marché en direct.",
    });
  });

  // Enregistre une analyse
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

  // Historique des analyses
  router.get("/analyses", requireAuth, async (req, res) => {
    const result = await pool.query(
      "SELECT * FROM analyses WHERE user_email = $1 ORDER BY created_at DESC",
      [req.userEmail]
    );
    res.json(result.rows);
  });

  return router;
};
