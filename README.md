# 🎯 Gouinche — Gestion de tournois

Application web légère pour organiser des sessions de gouinche : inscription en binôme ou solo, liste d'attente automatique, interface admin.

## Architecture

```
Node.js + Express  ←→  SQLite (mode WAL)
      ↓
  HTML/CSS/JS (vanilla, pas de build)
```

- **Base de données** : SQLite avec `journal_mode = WAL` — supporte les écritures concurrentes, zéro infrastructure, fichier unique.
- **Backend** : Express, ~200 lignes, pas de framework lourd.
- **Frontend** : HTML + Tailwind CSS (CDN), pas de bundler.
- **Déploiement** : Docker sur Fly.io, volume persistant pour la DB.

---

## Lancement en local

### Prérequis
- Node.js 18+

### Installation

```bash
cd gouinche-tournament
npm install
```

### Configuration

```bash
export ADMIN_PASSWORD="votre-mot-de-passe-secret"
# (optionnel) export DB_PATH="./gouinche.db"
```

### Démarrage

```bash
npm start
# ou en mode watch pour le dev :
npm run dev
```

Ouvrir http://localhost:3000

---

## Déploiement sur Fly.io (gratuit)

Fly.io offre un **tier gratuit** suffisant pour cette app : 3 VMs partagées, l'app se met en veille quand personne ne l'utilise (redémarrage en ~2s).

### 1. Installer flyctl

```bash
# macOS
brew install flyctl

# ou via script
curl -L https://fly.io/install.sh | sh
```

### 2. Créer un compte et se connecter

```bash
fly auth signup   # ou fly auth login si déjà inscrit
```

### 3. Déployer

```bash
cd gouinche-tournament

# Initialiser l'app (choisir un nom unique, région cdg = Paris)
fly launch --no-deploy

# Créer le volume persistant pour SQLite (1 Go gratuit)
fly volumes create gouinche_data --region cdg --size 1

# Définir le mot de passe admin (secret chiffré, jamais dans le code)
fly secrets set ADMIN_PASSWORD="votre-mot-de-passe-secret"

# Déployer
fly deploy
```

C'est tout. L'URL sera `https://[votre-app].fly.dev`.

### Mises à jour

```bash
fly deploy   # à chaque modification
```

### Consulter les logs

```bash
fly logs
```

---

## Variables d'environnement

| Variable         | Obligatoire | Description                          | Défaut              |
|------------------|-------------|--------------------------------------|---------------------|
| `ADMIN_PASSWORD` | ✅ Oui      | Mot de passe de l'interface admin    | —                   |
| `PORT`           | Non         | Port du serveur                      | `3000`              |
| `DB_PATH`        | Non         | Chemin vers le fichier SQLite        | `./gouinche.db`     |

---

## Coût estimé

| Scénario              | Coût mensuel |
|-----------------------|-------------|
| < 3 apps sur Fly.io   | **0 €**     |
| Volume 1 Go           | ~0,15 $/Go  |
| Trafic (< 100 GB/mois)| **0 €**     |

**Pour 20 utilisateurs occasionnels : pratiquement 0 €/mois.**

Si d'autres apps tournent déjà sur votre compte Fly.io et dépassent le tier gratuit, comptez ~2-3 $/mois.

---

## Structure du projet

```
gouinche-tournament/
├── server.js          # Serveur Express + toutes les routes API
├── package.json
├── Dockerfile
├── fly.toml           # Config Fly.io
└── public/
    ├── index.html     # Page d'accueil — liste des sessions
    ├── session.html   # Détail session + inscription
    └── admin.html     # Interface admin (protégée par mot de passe)
```

## API résumée

| Méthode | Route                          | Auth  | Description                    |
|---------|--------------------------------|-------|--------------------------------|
| GET     | `/api/sessions`                | —     | Liste des sessions              |
| GET     | `/api/sessions/:id`            | —     | Détail + inscriptions           |
| POST    | `/api/sessions`                | Admin | Créer une session               |
| DELETE  | `/api/sessions/:id`            | Admin | Supprimer une session           |
| POST    | `/api/sessions/:id/register`   | —     | S'inscrire (ou liste d'attente) |
| DELETE  | `/api/registrations/:id`       | —     | Se désinscrire                  |
| POST    | `/api/admin/verify`            | —     | Vérifier le mot de passe admin  |

L'auth admin se fait via le header HTTP `x-admin-password`.
