const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");
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
 
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const PROBLEM_ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    severityKey: { type: "string", enum: ["leger", "modere", "important", "critique"] },
    minCost: { type: "integer" },
    maxCost: { type: "integer" },
    riskPct: { type: "number" },
    explanation: { type: "string", description: "Une seule phrase en français, maximum 30 mots. Jamais plusieurs phrases ni de paragraphe." },
  },
  required: ["severityKey", "minCost", "maxCost", "riskPct", "explanation"],
  additionalProperties: false,
};

const PHOTO_ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    part: { type: "string" },
    level: { type: "string", enum: ["yellow", "orange", "red"] },
    label: { type: "string", description: "Description très courte du dégât, quelques mots (ex: 'Rayures superficielles')." },
    min: { type: "integer" },
    max: { type: "integer" },
    explanation: { type: "string", description: "Une seule phrase en français, maximum 25 mots. Jamais plusieurs phrases ni de paragraphe." },
  },
  required: ["part", "level", "label", "min", "max", "explanation"],
  additionalProperties: false,
};

function fallbackProblemEstimate() {
  return {
    severityKey: "modere", minCost: 300, maxCost: 900, riskPct: 0.02,
    explanation: "Estimation par défaut (l'analyse IA n'a pas pu être obtenue) — ajuste la gravité manuellement si besoin.",
  };
}

function fallbackPhotoEstimate() {
  return {
    part: "Dégât non identifié", level: "orange",
    label: "Estimation par défaut (analyse IA indisponible)",
    min: 200, max: 500, explanation: "",
  };
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["excellente_affaire", "bonne_affaire", "affaire_correcte", "a_negocier", "a_eviter"] },
    resaleDesirability: { type: "string", enum: ["elevee", "moyenne", "faible"], description: "Facilité à revendre ce modèle précis d'occasion en France." },
    riskLevel: { type: "string", enum: ["faible", "modere", "eleve"], description: "Risque de pannes/entretien coûteux pour cette motorisation précise." },
    maxPurchasePrice: { type: "integer", description: "Prix d'achat maximum recommandé en euros pour dégager une marge nette réaliste après réparations, carte grise et frais, compte tenu de la cote et de la facilité de revente de ce modèle précis." },
    maxPurchaseReasoning: { type: "string", description: "1 phrase courte justifiant le prix max (ex: marge cible, vitesse de revente)." },
    explanation: { type: "string", description: "2 phrases maximum, ton direct, orienté décision d'achat." },
    strengths: { type: "array", items: { type: "string" }, description: "2 à 3 points forts courts (5-10 mots chacun)." },
    concerns: { type: "array", items: { type: "string" }, description: "2 à 3 points de vigilance courts (5-10 mots chacun)." },
  },
  required: ["verdict", "resaleDesirability", "riskLevel", "maxPurchasePrice", "maxPurchaseReasoning", "explanation", "strengths", "concerns"],
  additionalProperties: false,
};

function fallbackVerdict(marketPrice, repairCosts) {
  // Filet de sécurité si l'IA est indisponible : marge cible de 12%, comme
  // avant que l'estimation ne soit confiée à l'IA.
  const maxPurchasePrice = Math.max(0, Math.round(((marketPrice || 0) - (repairCosts || 0) - (marketPrice || 0) * 0.12) / 500) * 500);
  return {
    verdict: "affaire_correcte",
    resaleDesirability: "moyenne",
    riskLevel: "modere",
    maxPurchasePrice,
    maxPurchaseReasoning: "Estimation par défaut (marge cible de 12%) — l'analyse IA n'a pas pu être obtenue.",
    explanation: "Analyse par défaut (l'IA n'a pas pu être obtenue) — vérifie l'historique d'entretien avant d'acheter.",
    strengths: [],
    concerns: [],
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
    if (!km && process.env.MARKET_DATA_API_KEY) {
      console.error("Avertissement : kilométrage manquant, MyTracks risque de ne renvoyer aucun résultat.");
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
 
        // Le format réel de MyTracks est { "predictions": [...] } — chaque
        // élément du tableau est une estimation individuelle (un "prix
        // comparable"). On calcule nos propres statistiques dessus avec
        // computeMarketStats, plutôt que de chercher des champs agrégés.
        const predictions = Array.isArray(data.predictions) ? data.predictions : [];
        const prices = predictions
          .map((p) => p.price ?? p.estimated_price ?? p.value)
          .filter((p) => typeof p === "number");
 
        if (prices.length > 0) {
          const stats = computeMarketStats(prices);
          await pool.query(
            `INSERT INTO market_prices_cache (brand, model, year, median_price, mean_price, min_price, max_price, comparables_count, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mytracks')`,
            [brand, model, year, stats.median, stats.mean, stats.min, stats.max, stats.comparablesCount]
          );
          return res.json({ isDemo: false, fromCache: false, ...stats, source: "mytracks" });
        }
        console.error("Réponse MyTracks inattendue ou vide, à vérifier :", JSON.stringify(data));
      } catch (e) {
        console.error("Erreur API marché (MyTracks) :", e.message);
      }
    }
 
    return res.json({
      isDemo: true,
      message: "Aucun fournisseur de données de marché configuré — réponse de démonstration.",
    });
  });
 
  // Verdict d'achat-revente IA : qualité du deal, facilité de revente du
  // modèle, risques de fiabilité connus — au-delà du simple calcul de marge.
  router.post("/verdict", requireAuth, async (req, res) => {
    const { vehicle, askingPrice, marketPrice, repairCosts, riskDiscount, comparables } = req.body;
    if (!vehicle || !askingPrice || !marketPrice) {
      return res.status(400).json({ error: "'vehicle', 'askingPrice' et 'marketPrice' requis." });
    }
    if (!anthropic) return res.json(fallbackVerdict(marketPrice, (repairCosts || 0) + (riskDiscount || 0)));

    // Donner les annonces comparables réelles (pas juste la moyenne) permet à
    // l'IA de raisonner sur la dispersion effective du marché, pas un chiffre
    // abstrait — analyse plus précise, surtout si le marché est hétérogène.
    const comparablesBlock = Array.isArray(comparables) && comparables.length > 0
      ? `\nAnnonces comparables réelles observées (La Centrale) :\n${comparables.map((c) => `- ${c.label}, ${c.year}, ${c.km?.toLocaleString("fr-FR")} km : ${c.price} €`).join("\n")}\n`
      : "";

    const prompt = `Tu es un expert en achat-revente de véhicules d'occasion en France. Analyse ce deal pour un professionnel qui envisage d'acheter pour revendre. Sois précis et rigoureux : appuie-toi sur les annonces comparables fournies plutôt que sur des généralités.

Véhicule : ${vehicle.brand} ${vehicle.model} ${vehicle.motorisation || ""}, ${vehicle.year}, ${vehicle.km} km, ${vehicle.fuel}, boîte ${vehicle.gearbox}, ${vehicle.power}ch.
Prix demandé par le vendeur : ${askingPrice} €.
Prix de marché estimé (comparables) : ${marketPrice} €.
Réparations et décote de risque déjà signalées sur ce véhicule : ${(repairCosts || 0) + (riskDiscount || 0)} €.
${comparablesBlock}
Donne un verdict d'achat-revente réaliste, basé sur ta connaissance du marché français de l'occasion :
- verdict : la qualité du deal financier (marge par rapport au marché)
- resaleDesirability : ce modèle/motorisation se revend-il facilement en France ? (demande, liquidité du marché occasion)
- riskLevel : cette motorisation/génération a-t-elle des points de fiabilité connus à surveiller (pannes fréquentes, coût d'entretien) ?
- maxPurchasePrice : le prix d'achat MAXIMUM que tu recommandes en euros pour ce véhicule précis, en tenant compte de la cote, des réparations déjà signalées, de la facilité de revente (un modèle qui se revend vite justifie une marge cible plus faible que 12% ; un modèle à faible demande ou à risque de fiabilité élevé justifie une marge plus large) et de frais annexes (carte grise, remise en état, marge). Un chiffre rond (multiple de 100€), jamais au-dessus de la cote.
- maxPurchaseReasoning : justifie ce chiffre en une phrase (marge cible retenue et pourquoi).
- strengths / concerns : sois concret et spécifique à CE modèle précis, pas générique.`;

    try {
      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 3000,
        output_config: { effort: "high", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);
      parsed.maxPurchasePrice = Math.max(0, Math.round(parsed.maxPurchasePrice));
      return res.json(parsed);
    } catch (e) {
      console.error("Erreur verdict IA :", e.message);
      return res.json(fallbackVerdict(marketPrice, (repairCosts || 0) + (riskDiscount || 0)));
    }
  });

  // Analyse IA d'un problème mécanique décrit avec ses propres mots par l'utilisateur.
  // Détermine la gravité et une fourchette de réparation réaliste pour ce véhicule précis.
  router.post("/problem-estimate", requireAuth, async (req, res) => {
    const { description, vehicle } = req.body;
    if (!description || !vehicle) {
      return res.status(400).json({ error: "'description' et 'vehicle' requis." });
    }
    if (!anthropic) return res.json(fallbackProblemEstimate());

    const prompt = `Tu es un expert automobile en France. Un acheteur envisage ce véhicule : ${vehicle.name}, ${vehicle.year}, ${vehicle.km} km, moteur ${vehicle.fuel} ${vehicle.power}ch (${vehicle.fiscalPower} CV fiscaux), boîte ${vehicle.gearbox}.
L'utilisateur décrit ce problème avec ses propres mots : "${description}".
Étudie cette description et détermine toi-même la gravité la plus probable (severityKey), une fourchette de coût de réparation RÉALISTE en France (ne surestime jamais), et une décote de risque.

Repères de calibration à respecter strictement :
- Un pneu simplement dégonflé (pas crevé, pas usé) : gonflage gratuit ou quelques euros, severityKey "leger", coût proche de 0 €.
- Un pneu crevé réparable (bouchon/mèche) : 15-30 €.
- Un pneu à changer (usé, hernie) : 80-150 € pièce.
- Un voyant allumé sans autre précision, une petite rayure, une ampoule grillée, un balai d'essuie-glace : quelques dizaines d'euros maximum, severityKey "leger".
- Ne choisis "important" ou "critique" que si la description implique clairement une panne mécanique/moteur/boîte sérieuse.
- N'invente jamais un problème plus grave que ce que l'utilisateur décrit réellement.
- riskPct est une fraction de la valeur du véhicule, entre 0 et 0.1 (ex: 0.02 pour 2%).
- explanation : UNE SEULE phrase courte (maximum 30 mots), pas de paragraphe, pas de conseils détaillés — juste la justification de l'estimation.`;

    try {
      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 1024,
        output_config: { effort: "medium", format: { type: "json_schema", schema: PROBLEM_ESTIMATE_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);
      return res.json({
        severityKey: parsed.severityKey,
        minCost: Math.max(0, Math.round(parsed.minCost)),
        maxCost: Math.max(0, Math.round(parsed.maxCost)),
        riskPct: Math.max(0, Math.min(0.1, parsed.riskPct)),
        explanation: parsed.explanation,
      });
    } catch (e) {
      console.error("Erreur estimation IA (problème) :", e.message);
      return res.json(fallbackProblemEstimate());
    }
  });

  // Analyse IA d'une photo de dégât esthétique/mécanique. Identifie la pièce
  // concernée, la gravité et une fourchette de réparation réaliste.
  router.post("/photo-estimate", requireAuth, async (req, res) => {
    const { imageBase64, mediaType, vehicle } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "'imageBase64' requis." });
    if (!anthropic) return res.json(fallbackPhotoEstimate());

    const prompt = `Tu es un expert carrossier en France. Analyse cette photo d'un véhicule d'occasion${vehicle?.name ? ` (${vehicle.name}, ${vehicle.year})` : ""} et identifie le dégât esthétique ou mécanique visible le plus important sur la photo.

Détermine :
- la pièce concernée (ex: "Pare-choc avant", "Aile avant droite", "Portière arrière gauche", "Jante avant droite")
- le niveau de gravité : "yellow" pour un dégât léger/esthétique (rayure superficielle, petite bosse), "orange" pour un dégât modéré (déformation, fissure), "red" pour un dégât grave nécessitant probablement un remplacement de pièce
- une fourchette de coût de réparation RÉALISTE en France pour ce type de dégât (ne surestime jamais)

Si la photo ne montre aucun dégât visible ou n'est pas exploitable, indique un niveau "yellow" avec un coût proche de 0 et explique-le dans "explanation".

"label" : quelques mots seulement (ex: "Rayures superficielles"). "explanation" : UNE SEULE phrase courte (maximum 25 mots), pas de paragraphe.`;

    try {
      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 1024,
        output_config: { effort: "medium", format: { type: "json_schema", schema: PHOTO_ESTIMATE_SCHEMA } },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 } },
            { type: "text", text: prompt },
          ],
        }],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);
      return res.json({
        part: parsed.part,
        level: parsed.level,
        label: parsed.label,
        min: Math.max(0, Math.round(parsed.min)),
        max: Math.max(0, Math.round(parsed.max)),
        explanation: parsed.explanation,
      });
    } catch (e) {
      console.error("Erreur estimation IA (photo) :", e.message);
      return res.json(fallbackPhotoEstimate());
    }
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
 
    const { vehicleName, plate, purchasePrice, margin, score, verdict, snapshot } = req.body;
    const result = await pool.query(
      `INSERT INTO analyses (user_email, vehicle_name, plate, purchase_price, margin, score, verdict, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.userEmail, vehicleName, plate, purchasePrice, margin, score, verdict, snapshot ? JSON.stringify(snapshot) : null]
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
 
