/**
 * Module de configuration - Chargement et validation des variables d'environnement
 *
 * Ce module centralise toutes les configurations de l'application.
 * Il charge les variables d'environnement depuis le fichier .env et les valide.
 *
 * @module config/env
 */

const dotenv = require('dotenv');
const path = require('path');

// Charger les variables d'environnement depuis le fichier .env
// Le fichier .env doit être à la racine du projet
dotenv.config({ path: path.join(__dirname, '../../.env') });

/**
 * Configuration de l'application
 * Toutes les variables d'environnement sont centralisées ici
 */
const config = {
  // ============================================
  // Configuration du serveur Express
  // ============================================
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
    isDevelopment: process.env.NODE_ENV === 'development',
  },

  // ============================================
  // Configuration Shopify
  // ============================================
  shopify: {
    // URL de la boutique (format: votre-boutique.myshopify.com)
    storeUrl: process.env.SHOPIFY_STORE_URL,

    // Token d'accès pour l'API Admin
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,

    // Secret pour vérifier la signature HMAC des webhooks
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,

    // ID de l'item d'inventaire du produit Hydrofeel
    inventoryItemId: process.env.SHOPIFY_INVENTORY_ITEM_ID,

    // ID de l'emplacement de stockage
    locationId: process.env.SHOPIFY_LOCATION_ID,

    // Version de l'API Shopify à utiliser
    apiVersion: '2024-01',
  },

  // ============================================
  // Configuration Sage X3 - Webservice SOAP
  // ============================================
  sageX3: {
    // URL du WSDL pour le client SOAP (pour récupérer le schéma)
    wsdlUrl: process.env.SAGE_X3_WSDL_URL,

    // URL de l'endpoint SOAP (pour les appels - soap-generic)
    endpointUrl: process.env.SAGE_X3_ENDPOINT_URL,

    // Credentials d'authentification (Basic Auth dans header HTTP uniquement)
    user: process.env.SAGE_X3_USER,
    password: process.env.SAGE_X3_PASSWORD,

    // Alias du pool de base de données (DOPHTA pour dev, POPHTA pour prod)
    poolAlias: process.env.SAGE_X3_POOL_ALIAS,

    // Code du site de stockage
    site: process.env.SAGE_X3_SITE || 'OPL',

    // Nom public du webservice
    publicName: process.env.SAGE_X3_PUBLIC_NAME || 'YSSTODIS',

    // Code langue pour Sage X3
    codeLang: 'FRA',

    // Certificat CA pour faire confiance au serveur Sage X3 (encodé en Base64)
    // Utilisé quand le serveur utilise un certificat auto-signé ou une CA interne
    clientCertBase64: process.env.SAGE_X3_CLIENT_CERT_BASE64,
  },

  // ============================================
  // Configuration Produit
  // ============================================
  product: {
    // Code EAN du produit Hydrofeel Larmes
    hydrofellEan: process.env.HYDROFEEL_EAN || '3661484004792',
  },

  // ============================================
  // Configuration SFTP
  // ============================================
  sftp: {
    host: process.env.SFTP_HOST,
    port: parseInt(process.env.SFTP_PORT, 10) || 22,
    user: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
    // Dossier de destination sur le serveur SFTP (legacy - pour compatibilité)
    remoteDir: process.env.SFTP_REMOTE_DIR || '/in/',
    // Dossier pour déposer les commandes (envoi vers ERP)
    remoteDirIn: process.env.SFTP_REMOTE_DIR_IN || '/in/',
    // Dossier pour lire les statuts (retour de l'ERP)
    remoteDirOut: process.env.SFTP_REMOTE_DIR_OUT || '/out/',
  },

  // ============================================
  // Configuration de la synchronisation des statuts commandes
  // ============================================
  statusSync: {
    // Activer/désactiver la synchronisation automatique des statuts
    enabled: process.env.STATUS_SYNC_ENABLED !== 'false',
    // Expression cron (par défaut: 2 fois par jour à 8h et 18h)
    cronExpression: process.env.STATUS_SYNC_CRON || '0 8,18 * * *',
    // Archiver les fichiers traités (true) ou les supprimer (false)
    archiveProcessed: process.env.STATUS_SYNC_ARCHIVE !== 'false',
    // Dossier d'archive pour les fichiers traités
    archiveDir: process.env.STATUS_SYNC_ARCHIVE_DIR || '/out/processed/',
  },

  // ============================================
  // Configuration du mode test
  // ============================================
  test: {
    // Si true, les fichiers sont sauvegardés localement au lieu d'être envoyés sur SFTP
    testMode: process.env.TEST_MODE === 'true',
    // Dossier local pour les fichiers de test
    localDownloadDir: process.env.LOCAL_DOWNLOAD_DIR || './test_files/',
  },

  // ============================================
  // Configuration des logs
  // ============================================
  logging: {
    // Niveau de log (error, warn, info, http, verbose, debug)
    level: process.env.LOG_LEVEL || 'info',
    // Durée de rétention des logs en jours
    retentionDays: parseInt(process.env.LOG_RETENTION_DAYS, 10) || 30,
  },

  // ============================================
  // Configuration du cron de synchronisation stock
  // ============================================
  stockSync: {
    // Expression cron (par défaut: toutes les heures à minute 0)
    cronExpression: process.env.STOCK_SYNC_CRON || '0 0 * * * *',
    // Activer/désactiver la synchronisation automatique
    enabled: process.env.STOCK_SYNC_ENABLED !== 'false',
  },

  // ============================================
  // Configuration de sécurité
  // ============================================
  security: {
    // Liste des IPs autorisées pour les webhooks (tableau)
    allowedIps: process.env.ALLOWED_IPS
      ? process.env.ALLOWED_IPS.split(',').map(ip => ip.trim())
      : [],
    // Timeout pour les appels API en millisecondes
    apiTimeout: parseInt(process.env.API_TIMEOUT, 10) || 30000,
    // Nombre de tentatives en cas d'échec réseau
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
  },
};

/**
 * Valide que les variables d'environnement requises sont présentes
 * Lance une erreur si une variable requise est manquante
 *
 * @param {Array<string>} requiredVars - Liste des variables requises
 * @throws {Error} Si une variable requise est manquante
 */
function validateRequiredVars(requiredVars) {
  const missing = requiredVars.filter(varName => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(
      `Variables d'environnement manquantes: ${missing.join(', ')}\n` +
      `Veuillez les définir dans le fichier .env`
    );
  }
}

/**
 * Valide la configuration au démarrage de l'application
 * Vérifie que toutes les variables critiques sont définies
 */
function validateConfig() {
  // En mode production, certaines variables sont obligatoires
  if (config.server.isProduction) {
    validateRequiredVars([
      'SHOPIFY_STORE_URL',
      'SHOPIFY_ACCESS_TOKEN',
      'SHOPIFY_WEBHOOK_SECRET',
      'SHOPIFY_INVENTORY_ITEM_ID',
      'SHOPIFY_LOCATION_ID',
      'SAGE_X3_WSDL_URL',
      'SAGE_X3_USER',
      'SAGE_X3_PASSWORD',
      'SAGE_X3_POOL_ALIAS',
      'SFTP_HOST',
      'SFTP_USER',
      'SFTP_PASSWORD',
    ]);
  }

  // Toujours valider la configuration Sage X3 (nécessaire pour les tests)
  if (!config.sageX3.wsdlUrl) {
    console.warn('⚠️  SAGE_X3_WSDL_URL non défini - Les appels Sage X3 échoueront');
  }
}

/**
 * Affiche un résumé de la configuration (sans les secrets)
 * Utile pour le débogage au démarrage
 */
function printConfigSummary() {
  console.log('\n📋 Configuration chargée:');
  console.log(`   • Environnement: ${config.server.nodeEnv}`);
  console.log(`   • Port: ${config.server.port}`);
  console.log(`   • Mode test: ${config.test.testMode ? 'Activé' : 'Désactivé'}`);
  console.log(`   • Sync stock auto: ${config.stockSync.enabled ? 'Activé' : 'Désactivé'}`);
  console.log(`   • Sync statuts auto: ${config.statusSync.enabled ? 'Activé' : 'Désactivé'}`);
  console.log(`   • Shopify configuré: ${config.shopify.storeUrl ? 'Oui' : 'Non'}`);
  console.log(`   • Sage X3 configuré: ${config.sageX3.wsdlUrl ? 'Oui' : 'Non'}`);
  console.log(`   • SFTP configuré: ${config.sftp.host ? 'Oui' : 'Non'}`);
  if (config.sftp.host) {
    console.log(`     - Dossier IN (commandes): ${config.sftp.remoteDirIn}`);
    console.log(`     - Dossier OUT (statuts): ${config.sftp.remoteDirOut}`);
  }
  console.log('');
}

module.exports = {
  config,
  validateConfig,
  validateRequiredVars,
  printConfigSummary,
};
