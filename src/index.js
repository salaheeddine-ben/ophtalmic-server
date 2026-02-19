/**
 * Point d'entrée principal - Serveur Express Ophtalmic Middleware
 *
 * Ce serveur fait office de passerelle entre Shopify et l'ERP Sage X3.
 *
 * Fonctionnalités principales :
 * 1. Synchronisation du stock (Sage X3 → Shopify) via cron job
 * 2. Export des commandes (Shopify → SFTP) via webhooks
 *
 * @module index
 */

const express = require('express');
const helmet = require('helmet');
const { config, validateConfig, printConfigSummary } = require('./config/env');
const { logger, logRequest } = require('./utils/logger');
const { verifyShopifyWebhook, logWebhook } = require('./middlewares/shopifyWebhookAuth');
const webhookRoutes = require('./routes/webhookRoutes');
const testRoutes = require('./routes/testRoutes');
const { startStockSyncJob, getStats: getStockSyncStats } = require('./jobs/stockSyncJob');
const { startStatusSyncJob, getStats: getStatusSyncStats } = require('./jobs/statusSyncJob');

// Logger principal
const log = logger;

// Créer l'application Express
const app = express();

// ============================================
// Configuration de la sécurité
// ============================================

// Helmet ajoute des headers de sécurité
app.use(helmet({
  // Désactiver certaines protections qui peuvent interférer avec les webhooks
  contentSecurityPolicy: false,
}));

// Faire confiance aux proxies (pour récupérer l'IP réelle)
app.set('trust proxy', 1);

// ============================================
// Configuration du parsing des requêtes
// ============================================

// IMPORTANT: Les webhooks Shopify doivent recevoir le body brut pour la vérification HMAC
// On configure donc express.raw() AVANT express.json() pour les routes webhook

// Route webhook avec body brut (nécessaire pour la vérification HMAC)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use('/webhook', logWebhook);
app.use('/webhook', verifyShopifyWebhook);

// Autres routes avec JSON parser standard
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================
// Middleware de logging des requêtes
// ============================================
app.use(logRequest);

// ============================================
// Routes de l'application
// ============================================

// Route de santé principale
app.get('/', (req, res) => {
  res.json({
    name: 'Ophtalmic Middleware',
    version: '1.0.0',
    description: 'Passerelle Shopify ↔ Sage X3',
    status: 'running',
    environment: config.server.nodeEnv,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /',
      healthCheck: 'GET /health',
      webhooks: 'POST /webhook/orders/paid',
      test: 'GET /test/*',
    },
  });
});

// Route de vérification de santé (pour les load balancers, etc.)
app.get('/health', (req, res) => {
  const stockSyncStats = getStockSyncStats();
  const statusSyncStats = getStatusSyncStats();

  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    environment: config.server.nodeEnv,
    testMode: config.test.testMode,
    stockSync: {
      enabled: config.stockSync.enabled,
      isRunning: stockSyncStats.isRunning,
      lastRun: stockSyncStats.lastRun,
      lastSuccess: stockSyncStats.lastSuccess,
      nextRun: stockSyncStats.nextRun,
      successCount: stockSyncStats.successCount,
      errorCount: stockSyncStats.errorCount,
    },
    statusSync: {
      enabled: config.statusSync.enabled,
      isRunning: statusSyncStats.isRunning,
      lastRun: statusSyncStats.lastRun,
      lastSuccess: statusSyncStats.lastSuccess,
      nextRun: statusSyncStats.nextRun,
      successCount: statusSyncStats.successCount,
      errorCount: statusSyncStats.errorCount,
      totalFilesProcessed: statusSyncStats.totalFilesProcessed,
      totalOrdersUpdated: statusSyncStats.totalOrdersUpdated,
    },
    timestamp: new Date().toISOString(),
  });
});

// Routes des webhooks Shopify
app.use('/webhook', webhookRoutes);

// Routes de test (pour le développement et les diagnostics)
app.use('/test', testRoutes);

// ============================================
// Gestion des erreurs 404
// ============================================
app.use((req, res) => {
  log.warn('Route non trouvée', {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  res.status(404).json({
    error: 'Route non trouvée',
    path: req.path,
    method: req.method,
    availableEndpoints: {
      health: 'GET /',
      webhooks: 'POST /webhook/orders/paid',
      test: 'GET /test/*',
    },
  });
});

// ============================================
// Gestion globale des erreurs
// ============================================
app.use((err, req, res, _next) => {
  log.error('Erreur non gérée', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Ne pas exposer les détails de l'erreur en production
  const errorResponse = {
    error: 'Une erreur est survenue',
    message: config.server.isProduction ? 'Erreur interne du serveur' : err.message,
  };

  if (!config.server.isProduction) {
    errorResponse.stack = err.stack;
  }

  res.status(err.status || 500).json(errorResponse);
});

// ============================================
// Démarrage du serveur
// ============================================

/**
 * Initialise et démarre le serveur
 */
async function startServer() {
  try {
    // Afficher le banner au démarrage
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║           🔷 OPHTALMIC MIDDLEWARE SERVER 🔷               ║
║                                                           ║
║     Passerelle Shopify ↔ Sage X3                          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);

    // Valider la configuration
    validateConfig();
    printConfigSummary();

    // Démarrer le job de synchronisation du stock
    const stockJob = startStockSyncJob();

    if (stockJob) {
      log.info('Job de synchronisation du stock initialisé', {
        nextRun: stockJob.nextDate().toISO(),
      });
    }

    // Démarrer le job de synchronisation des statuts de commandes
    const statusJob = startStatusSyncJob();

    if (statusJob) {
      log.info('Job de synchronisation des statuts initialisé', {
        nextRun: statusJob.nextDate().toISO(),
      });
    }

    // Démarrer le serveur HTTP
    const server = app.listen(config.server.port, () => {
      log.info('Serveur démarré', {
        port: config.server.port,
        environment: config.server.nodeEnv,
        url: `http://localhost:${config.server.port}`,
      });

      console.log(`
🚀 Serveur démarré avec succès !

   URL locale: http://localhost:${config.server.port}

📡 Endpoints disponibles:
   • GET  /           - Informations du serveur
   • GET  /health     - Vérification de santé
   • POST /webhook/*  - Webhooks Shopify
   • GET  /test/*     - Routes de test

📋 Mode: ${config.test.testMode ? 'TEST (fichiers locaux)' : 'PRODUCTION (SFTP)'}
      `);
    });

    // Gestion propre de l'arrêt du serveur
    setupGracefulShutdown(server);

  } catch (error) {
    log.error('Erreur fatale au démarrage', {
      error: error.message,
      stack: error.stack,
    });

    console.error('\n❌ Erreur fatale au démarrage:', error.message);
    process.exit(1);
  }
}

/**
 * Configure l'arrêt gracieux du serveur
 *
 * @param {Object} server - Instance du serveur HTTP
 */
function setupGracefulShutdown(server) {
  const shutdown = async (signal) => {
    log.info(`Signal ${signal} reçu - Arrêt du serveur...`);
    console.log(`\n🛑 Signal ${signal} reçu - Arrêt gracieux en cours...`);

    // Arrêter les jobs de synchronisation
    const { stopStockSyncJob } = require('./jobs/stockSyncJob');
    const { stopStatusSyncJob } = require('./jobs/statusSyncJob');
    stopStockSyncJob();
    stopStatusSyncJob();

    // Fermer le serveur HTTP
    server.close((err) => {
      if (err) {
        log.error('Erreur lors de la fermeture du serveur', { error: err.message });
        process.exit(1);
      }

      log.info('Serveur arrêté proprement');
      console.log('✅ Serveur arrêté proprement');
      process.exit(0);
    });

    // Forcer l'arrêt après 10 secondes
    setTimeout(() => {
      log.error('Arrêt forcé après timeout');
      console.error('⚠️  Arrêt forcé après timeout');
      process.exit(1);
    }, 10000);
  };

  // Écouter les signaux d'arrêt
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Gérer les erreurs non capturées
  process.on('uncaughtException', (error) => {
    log.error('Exception non capturée', {
      error: error.message,
      stack: error.stack,
    });
    console.error('\n❌ Exception non capturée:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    log.error('Promesse rejetée non gérée', {
      reason: reason?.message || reason,
      stack: reason?.stack,
    });
    console.error('\n❌ Promesse rejetée non gérée:', reason);
  });
}

// Démarrer le serveur
startServer();

// Exporter l'app pour les tests
module.exports = app;
