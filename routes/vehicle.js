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
// Fonctionne pour les véhicules du monde entier grâce à la norme ISO 3779,
// même si les données sont parfois moins complètes hors des véhicules vendus aux USA.
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
 
// Calcule médiane, moyenne, min/max et un score de confiance à partir d'une
// liste de prix comparables. Ne dit RIEN sur l'origine de ces prix — cette
// fonction est indépendante de la source (fournisseur licencié ou saisie manuelle).
function computeMarketStats(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const mean = sorted.reduce((sum, p) => sum + p, 0) / n;
  const min = sorted[0];
  const max = sorted[n - 1];
  // Confiance simple basée sur le nombre de comparables disponibles
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
  // Identifie un véhicule à partir d'une plaque française (RegCheck) ou d'un VIN (NHTSA, gratuit).
  router.post("/lookup", requireAuth, async (req, res) => {
    const { plate } = req.body;
    if (!plate) return res.status(400).json({ error: "Plaque ou VIN requis." });
 
    // VIN : décodage gratuit, toujours tenté en premier si le format correspond
    if (isVin(plate)) {
      try {
        const vehicleData = await decodeVin(plate);
        return res.json(vehicleData);
      } catch (e) {
        console.error("Erreur décodage VIN (NHTSA) :", e.message);
        // On retombe sur la démonstration ci-dessous plutôt que de bloquer l'utilisateur
      }
    } else if (process.env.VEHICLE_API_KEY) {
      // Plaque française via RegCheck.org.uk (même fournisseur qu'ImmatriculationAPI.com).
      // VEHICLE_API_KEY doit contenir le "username" du compte RegCheck.
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
      message: "Aucun fournisseur réel configuré ou VIN non reconnu — réponse de démonstration.",
    });
  });
 
  // Prix du marché — vérifie d'abord le cache (moins de 14 jours), sinon
  // interroge le fournisseur configuré (ex: MyTracks), sinon démonstration.
  // Libellés à utiliser côté app : "Prix du marché", "Valeur de revente
  // estimée", "Médiane des comparables" — jamais "Cote Argus".
  router.post("/market", requireAuth, async (req, res) => {
    const { brand, model, year, km, fuel } = req.body;
    if (!brand || !model || !year) {
      return res.status(400).json({ error: "Marque, modèle et année requis." });
    }
 
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
 
    if (process.env.MARKET_DATA_API_KEY) {
      try {
        const providerRes = await fetch("https://api.mytracks.fr/v1/pricing", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": process.env.MARKET_DATA_API_KEY,
          },
          body: JSON.stringify({
            brand,
            model,
            year: Number(year),
            mileage: km ? Number(km) : undefined,
            fuel: fuel || undefined,
          }),
        });
        const data = await providerRes.json();
 
        // Le format exact de réponse de MyTracks n'a pas pu être vérifié à
        // l'avance — on tente plusieurs noms de champs courants. Si aucun ne
        // correspond, le message loggué ci-dessous montrera la vraie forme
        // de la réponse pour ajuster ce mapping précisément.
        const median = data.price ?? data.median_price ?? data.median ?? data.estimated_price ?? data.medianPrice;
        const mean = data.average_price ?? data.mean ?? data.averagePrice;
        const min = data.min_price ?? data.price_min ?? data.min ?? data.minPrice;
        const max = data.max_price ?? data.price_max ?? data.max ?? data.maxPrice;
        const count = data.sample_size ?? data.comparablesCount ?? data.count ?? 0;
 
        if (median != null) {
          const stats = {
            median: Math.round(median),
            mean: Math.round(mean ?? median),
            min: Math.round(min ?? median * 0.85),
            max: Math.round(max ?? median * 1.15),
            comparablesCount: count,
            confidence: count >= 20 ? "élevée" : count >= 8 ? "moyenne" : "faible",
          };
          await pool.query(
            `INSERT INTO market_prices_cache (brand, model, year, median_price, mean_price, min_price, max_price, comparables_count, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mytracks')`,
            [brand, model, year, stats.median, stats.mean, stats.min, stats.max, stats.comparablesCount]
          );
          return res.json({ isDemo: false, fromCache: false, ...stats, source: "mytracks" });
        }
        console.error("Réponse MyTracks inattendue, à vérifier :", JSON.stringify(data));
      } catch (e) {
        console.error("Erreur API marché (MyTracks) :", e.message);
      }
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
 






