require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { Pool } = require("pg");
 
const app = express();
// Supabase exige une connexion chiffrée (SSL). Sans cette option, la connexion
// échoue et provoquait un plantage complet du serveur (crash au lieu d'une
// simple erreur affichée).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
// Sans ce filet de sécurité, une erreur de connexion à la base de données
// (perte réseau, identifiants expirés, etc.) fait planter tout le serveur
// au lieu de simplement logguer le problème.
pool.on("error", (err) => {
  console.error("Erreur inattendue de connexion à la base de données :", err.message);
});
 
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
 
app.get("/health", (req, res) => res.json({ ok: true }));
 
app.use("/api/auth", require("./routes/auth")(pool));
app.use("/api/users", require("./routes/users")(pool));
app.use("/api/messages", require("./routes/messages")(pool));
app.use("/api/vehicle", require("./routes/vehicle")(pool));
app.use("/api/iap", require("./routes/iap")(pool));
 
// Gestion d'erreur générique (évite qu'une erreur ne fasse planter le serveur)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoProfit backend démarré sur le port ${PORT}`));
