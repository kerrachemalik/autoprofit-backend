const express = require("express");
const router = express.Router();
const { ApifyClient } = require("apify-client");
const { requireAuth } = require("../middleware/auth");

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function buildStartUrl({ make, model, energy, gearbox, priceMax, priceMin, yearMin, yearMax }) {
  if (!make || !model) return null;
  const params = new URLSearchParams();
  params.set("makesModelsCommercialNames", `${make.toUpperCase()}::${model.toUpperCase()}`);
  if (energy) params.set("energies", energy);
  if (gearbox) params.set("gearbox", gearbox);
  if (priceMax) params.set("priceMax", priceMax);
  if (priceMin) params.set("priceMin", priceMin);
  if (yearMin) params.set("yearMin", yearMin);
  if (yearMax) params.set("yearMax", yearMax);
  return `https://www.lacentrale.fr/listing?${params.toString()}`;
}

// Régression linéaire simple (prix ~ kilométrage) : donne une estimation plus
// réaliste qu'une moyenne brute, car le prix baisse avec le kilométrage.
function estimateValueByMileage(listings, targetMileage) {
  const n = listings.length;
  const sumX = listings.reduce((s, l) => s + l.mileage, 0);
  const sumY = listings.reduce((s, l) => s + l.price, 0);
  const sumXY = listings.reduce((s, l) => s + l.mileage * l.price, 0);
  const sumX2 = listings.reduce((s, l) => s + l.mileage * l.mileage, 0);
  const denom = n * sumX2 - sumX * sumX;

  if (n < 3 || denom === 0) return null; // pas assez de variance pour une régression fiable

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return Math.round(slope * targetMileage + intercept);
}

module.exports = (pool) => {
  // Recherche des annonces comparables sur La Centrale (via acteur Apify) et,
  // si un kilométrage cible est fourni, calcule une cote estimée.
  router.post("/", requireAuth, async (req, res) => {
    if (!process.env.APIFY_TOKEN) {
      return res.status(503).json({ error: "Recherche d'annonces non configurée (APIFY_TOKEN manquant)." });
    }

    const { startUrl: providedUrl, make, model, energy, gearbox, priceMax, priceMin, yearMin, yearMax, targetMileage } = req.body;
    const limit = Math.min(Number(req.body.limit) || DEFAULT_LIMIT, MAX_LIMIT);

    const startUrl = providedUrl || buildStartUrl({ make, model, energy, gearbox, priceMax, priceMin, yearMin, yearMax });
    if (!startUrl) {
      return res.status(400).json({ error: "Fournis soit 'startUrl', soit au moins 'make' et 'model'." });
    }

    try {
      const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
      const run = await client.actor(process.env.LACENTRALE_ACTOR_ID).call({
        startUrl,
        vehicleType: "carsAndUtilities",
        sortPreset: "newestListings",
        limit,
      });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();

      const listings = items
        .filter((it) => typeof it.price === "number" && typeof it.vehicle?.mileage === "number")
        .map((it) => ({
          reference: it.reference,
          price: it.price,
          mileage: it.vehicle.mileage,
          year: it.vehicle.year,
          make: it.vehicle.make,
          model: it.vehicle.model,
          version: it.vehicle.version,
          gearbox: it.vehicle.gearbox,
          energy: it.vehicle.energy,
          department: it.location?.visitPlace || "",
          photoUrl: it.photoUrl,
        }));

      if (listings.length === 0) {
        return res.json({ startUrl, count: 0, listings: [], stats: null, message: "Aucune annonce comparable trouvée." });
      }

      const prices = listings.map((l) => l.price);
      const averagePrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
      const stats = {
        averagePrice,
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        estimatedValue: targetMileage ? estimateValueByMileage(listings, Number(targetMileage)) ?? averagePrice : null,
      };

      return res.json({ startUrl, count: listings.length, listings, stats });
    } catch (e) {
      console.error("Erreur recherche La Centrale (Apify) :", e.message);
      return res.status(502).json({ error: "La recherche d'annonces a échoué (fournisseur indisponible)." });
    }
  });

  return router;
};
