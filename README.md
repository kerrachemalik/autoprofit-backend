# AutoProfit — Backend

Remplace le stockage `window.storage` (propre à Claude) par une vraie base de
données PostgreSQL et une API sécurisée, utilisables une fois l'app publiée
en dehors de Claude.

## 1. Créer la base de données (Supabase — le plus simple pour démarrer)

1. Crée un compte sur [supabase.com](https://supabase.com) (gratuit pour démarrer).
2. Crée un nouveau projet.
3. Onglet **SQL Editor** → colle le contenu de `db/schema.sql` → Run.
4. Onglet **Project Settings > Database** → copie la "Connection string" → colle-la dans `DATABASE_URL` de ton `.env`.

## 2. Configurer les variables d'environnement

```
cp .env.example .env
```

Remplis au minimum `DATABASE_URL` et `JWT_SECRET` (génère-le avec `openssl rand -hex 32`).
`ADMIN_EMAIL` est déjà pré-rempli avec ton adresse.

## 3. Installer et lancer en local

```
npm install
npm run dev
```

Le serveur écoute sur `http://localhost:3000`. Teste avec :
```
curl http://localhost:3000/health
```

## 4. Déployer en ligne (pour que l'app mobile puisse l'appeler)

Options simples et peu coûteuses : **Render**, **Railway**, ou **Fly.io**.
Toutes fonctionnent de façon similaire :
1. Connecte ton dépôt Git (ou importe ce dossier).
2. Renseigne les mêmes variables d'environnement que ton `.env`.
3. Le service te donne une URL publique (ex: `https://autoprofit-api.onrender.com`) — c'est cette URL que l'app mobile appellera.

## 5. Endpoints disponibles

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/signup` | Créer un compte |
| POST | `/api/auth/login` | Se connecter |
| POST | `/api/auth/reset-password` | Réinitialiser le mot de passe |
| GET | `/api/users/me` | Mon profil |
| GET | `/api/users` | *(admin)* Liste de tous les utilisateurs |
| POST | `/api/messages` | Envoyer un message de support |
| GET | `/api/messages` | *(admin)* Boîte de réception |
| PATCH | `/api/messages/:id/read` | *(admin)* Marquer comme lu |
| POST | `/api/vehicle/lookup` | Identifier un véhicule par plaque/VIN |
| POST | `/api/vehicle/market` | Prix de marché d'un véhicule |
| POST | `/api/vehicle/analyses` | Enregistrer une analyse (vérifie le quota) |
| GET | `/api/vehicle/analyses` | Historique de mes analyses |
| POST | `/api/iap/verify-receipt` | Valider un achat Apple et activer Premium |

## 6. Ce qu'il reste à faire

- Brancher un vrai fournisseur de données véhicule/marché (`routes/vehicle.js`, sections `TODO`).
- Ajouter l'envoi d'un vrai e-mail pour "mot de passe oublié" (ex: Resend, SendGrid) avant d'autoriser `reset-password`.
- Une fois l'app iOS connectée à cette API (au lieu de `window.storage`), suivre `../ios-storekit/IAP_SETUP.md` pour le paiement réel.
