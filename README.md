# Ophtalmic Middleware

Serveur Node.js servant de passerelle entre Shopify et l'ERP Sage X3 pour Ophtalmic.

## Fonctionnalités

### 1. Synchronisation du stock (Sage X3 → Shopify)

- Interrogation automatique du webservice SOAP Sage X3 toutes les heures
- Récupération du stock du produit "Hydrofeel Larmes" (EAN: 3661484004792)
- Mise à jour automatique du niveau d'inventaire sur Shopify

### 2. Export des commandes (Shopify → SFTP)

- Réception des webhooks Shopify pour les commandes payées
- Génération de fichiers TXT formatés pour Sage X3
- Envoi automatique sur le serveur SFTP (ou sauvegarde locale en mode test)

## Installation

### Prérequis

- Node.js >= 18.0.0
- npm ou yarn

### Étapes d'installation

```bash
# Cloner le projet
git clone <repository-url>
cd ophtalmic-middleware

# Installer les dépendances
npm install

# Copier et configurer le fichier d'environnement
cp .env.example .env
# Éditer .env avec vos paramètres

# Démarrer en mode développement
npm run dev

# Ou démarrer en production
npm start
```

## Configuration

### Variables d'environnement

Copiez `.env.example` vers `.env` et configurez les variables :

#### Serveur

```env
PORT=3000
NODE_ENV=development
```

#### Shopify

```env
SHOPIFY_STORE_URL=votre-boutique.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx
SHOPIFY_WEBHOOK_SECRET=whsec_xxxxx
SHOPIFY_INVENTORY_ITEM_ID=xxxxx
SHOPIFY_LOCATION_ID=xxxxx
```

Pour trouver les IDs Shopify :
1. Démarrez le serveur en mode dev
2. Appelez `GET /test/shopify-config` pour voir les locations
3. Appelez `GET /test/shopify-product/3661484004792` pour trouver l'inventory_item_id

#### Sage X3

```env
SAGE_X3_WSDL_URL=https://x3v12webservice-dev.ophtalmic.fr:4433/soap-wsdl/syracuse/collaboration/syracuse/CAdxWebServiceXmlCC?wsdl
SAGE_X3_USER=WBSRV
SAGE_X3_PASSWORD=wbsrv14
SAGE_X3_POOL_ALIAS=DOPHTA  # POHTA pour la production
SAGE_X3_SITE=OPL
```

#### SFTP

```env
SFTP_HOST=sftp.ophtalmic.fr
SFTP_PORT=22
SFTP_USER=LSRAgence
SFTP_PASSWORD=xxxxx
SFTP_REMOTE_DIR=/commandes/
```

#### Mode test

```env
TEST_MODE=true              # true = fichiers locaux, false = SFTP
LOCAL_DOWNLOAD_DIR=./test_files/
```

## Endpoints API

### Santé

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/` | Informations du serveur |
| GET | `/health` | Vérification de santé détaillée |

### Webhooks Shopify

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/webhook/orders/paid` | Webhook commande payée |
| POST | `/webhook/orders/create` | Webhook création commande |
| POST | `/webhook/orders/cancelled` | Webhook annulation |
| GET | `/webhook/health` | Santé des webhooks |

### Routes de test

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/test/stock` | Tester l'appel Sage X3 |
| GET | `/test/sage-connection` | Tester la connexion SOAP |
| GET | `/test/sftp` | Tester la connexion SFTP |
| GET | `/test/shopify-connection` | Tester l'API Shopify |
| GET | `/test/shopify-config` | Récupérer les IDs Shopify |
| GET | `/test/config` | Afficher la configuration |
| POST | `/test/generate-order-file` | Générer un fichier de test |
| POST | `/test/sync-stock` | Lancer une sync manuelle |
| GET | `/test/local-files` | Lister les fichiers locaux |

## Format du fichier de commande

```
ENTETE
REF_COMMANDE|#12345
DATE_COMMANDE|2024-01-15
REF_CLIENT|0147907400
EMAIL_CLIENT|client@example.com
TELEPHONE|+33123456789
NOM|Dupont
PRENOM|Jean
SOCIETE|
ADRESSE|123 Rue Example
ADRESSE2|
CP|75001
VILLE|Paris
PROVINCE|Île-de-France
PAYS|FR
FRAIS_PORT|5.90
MONTANT_HT|74.92
MONTANT_TAXES|14.98
MONTANT_TTC|89.90
DEVISE|EUR
MODE_PAIEMENT|shopify_payments
TRANSACTION_CB|abc123
...

LIGNES
SKU|DESIGNATION|QTE|PRIX_UNITAIRE_HT|PRIX_UNITAIRE_TTC|REMISE
HYDRO-001|Hydrofeel Larmes 10ml|2|24.92|29.90|0.00
```

## Configuration du webhook Shopify

1. Allez dans votre admin Shopify : **Settings > Notifications > Webhooks**
2. Créez un nouveau webhook :
   - **Event** : Order payment
   - **URL** : `https://votre-serveur.com/webhook/orders/paid`
   - **Format** : JSON
3. Copiez le secret du webhook dans `SHOPIFY_WEBHOOK_SECRET`

## Architecture du projet

```
ophtalmic-middleware/
├── src/
│   ├── index.js                 # Point d'entrée Express
│   ├── config/
│   │   └── env.js               # Chargement variables d'environnement
│   ├── services/
│   │   ├── sageX3Service.js     # Client SOAP Sage X3
│   │   ├── shopifyService.js    # API Admin Shopify
│   │   ├── sftpService.js       # Client SFTP
│   │   └── orderExportService.js # Génération fichier TXT
│   ├── routes/
│   │   ├── webhookRoutes.js     # Routes webhook Shopify
│   │   └── testRoutes.js        # Routes de test
│   ├── jobs/
│   │   └── stockSyncJob.js      # Cron job sync stock
│   ├── middlewares/
│   │   └── shopifyWebhookAuth.js # Vérification HMAC
│   └── utils/
│       └── logger.js            # Winston logger
├── test_files/                  # Fichiers générés en mode test
├── logs/                        # Fichiers de logs
├── .env.example                 # Template de configuration
├── .env                         # Configuration (non versionné)
├── package.json
└── README.md
```

## Logs

Les logs sont stockés dans le dossier `logs/` :

- `combined-YYYY-MM-DD.log` : Tous les logs
- `error-YYYY-MM-DD.log` : Erreurs uniquement
- `webhooks-YYYY-MM-DD.log` : Logs des webhooks Shopify
- `stock-sync-YYYY-MM-DD.log` : Logs de la synchronisation stock

## Développement

```bash
# Mode développement avec rechargement automatique
npm run dev

# Linter
npm run lint

# Tests
npm test
```

## Passage en production

1. Configurez `NODE_ENV=production`
2. Définissez `TEST_MODE=false` pour activer l'envoi SFTP
3. Changez `SAGE_X3_POOL_ALIAS=POHTA` pour la base de production
4. Vérifiez que tous les credentials sont corrects
5. Configurez un reverse proxy (nginx) avec SSL
6. Utilisez PM2 ou Docker pour la gestion du processus

### Exemple avec PM2

```bash
npm install -g pm2
pm2 start src/index.js --name ophtalmic-middleware
pm2 save
pm2 startup
```

### Exemple avec Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "src/index.js"]
```

## Sécurité

- Les webhooks Shopify sont vérifiés via signature HMAC-SHA256
- Helmet.js ajoute des headers de sécurité HTTP
- Les credentials sont stockés dans les variables d'environnement
- Les logs ne contiennent pas de données sensibles

## Dépannage

### Le webhook échoue avec 401

- Vérifiez `SHOPIFY_WEBHOOK_SECRET` dans `.env`
- Assurez-vous que le secret correspond à celui configuré dans Shopify

### Connexion Sage X3 impossible

- Vérifiez l'URL du WSDL et les credentials
- Testez avec `GET /test/sage-connection`
- Vérifiez que le serveur peut atteindre le webservice Sage X3

### Le stock ne se met pas à jour sur Shopify

- Vérifiez `SHOPIFY_INVENTORY_ITEM_ID` et `SHOPIFY_LOCATION_ID`
- Testez avec `GET /test/shopify-config` pour trouver les bons IDs
- Vérifiez les permissions du token API Shopify

## Support

Pour toute question ou problème, contactez l'équipe technique.

## Licence

Propriétaire - Ophtalmic
