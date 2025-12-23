/**
 * Job de synchronisation du stock - Cron job pour synchroniser le stock Sage X3 -> Shopify
 *
 * Ce module configure et exécute un job planifié (cron) qui :
 * 1. Interroge le webservice Sage X3 pour récupérer le stock
 * 2. Met à jour le niveau d'inventaire sur Shopify
 *
 * Par défaut, le job s'exécute toutes les heures (configurable via STOCK_SYNC_CRON).
 *
 * @module jobs/stockSyncJob
 */

const { CronJob } = require('cron');
const { config } = require('../config/env');
const { stockSyncLogger } = require('../utils/logger');
const sageX3Service = require('../services/sageX3Service');
const shopifyService = require('../services/shopifyService');

// Logger dédié à la synchronisation stock
const log = stockSyncLogger;

// Référence au job cron (pour pouvoir l'arrêter si nécessaire)
let stockSyncJob = null;

// Statistiques de synchronisation
const syncStats = {
  lastRun: null,
  lastSuccess: null,
  lastError: null,
  successCount: 0,
  errorCount: 0,
  totalRuns: 0,
};

/**
 * Exécute la synchronisation du stock
 *
 * Cette fonction est appelée par le job cron ou manuellement.
 * Elle :
 * 1. Récupère le stock depuis Sage X3
 * 2. Met à jour Shopify si le stock a changé
 * 3. Log le résultat
 *
 * @returns {Promise<Object>} Résultat de la synchronisation
 */
async function executeStockSync() {
  const startTime = Date.now();
  syncStats.totalRuns++;
  syncStats.lastRun = new Date();

  log.info('Début de la synchronisation du stock', {
    eanCode: config.product.hydrofellEan,
    runNumber: syncStats.totalRuns,
  });

  try {
    // ============================================
    // Étape 1 : Récupérer le stock depuis Sage X3
    // ============================================
    log.info('Appel du webservice Sage X3...');

    const stockData = await sageX3Service.getProductStock(config.product.hydrofellEan);

    log.info('Stock récupéré depuis Sage X3', {
      quantity: stockData.quantity,
      available: stockData.available,
      message: stockData.message,
    });

    // ============================================
    // Étape 2 : Vérifier la configuration Shopify
    // ============================================
    if (!config.shopify.inventoryItemId || !config.shopify.locationId) {
      log.warn('Configuration Shopify incomplète - Mise à jour impossible', {
        inventoryItemId: config.shopify.inventoryItemId || 'NON CONFIGURÉ',
        locationId: config.shopify.locationId || 'NON CONFIGURÉ',
      });

      // En mode test/dev, on peut quand même retourner les données Sage X3
      if (config.test.testMode) {
        return {
          success: true,
          partial: true,
          message: 'Stock récupéré de Sage X3 mais Shopify non configuré',
          sageX3Stock: stockData,
          duration: Date.now() - startTime,
        };
      }

      throw new Error('Configuration Shopify incomplète');
    }

    // ============================================
    // Étape 3 : Récupérer le stock actuel Shopify
    // ============================================
    let currentShopifyStock = null;
    try {
      const inventoryLevel = await shopifyService.getInventoryLevel();
      currentShopifyStock = inventoryLevel?.available;

      log.debug('Stock actuel Shopify', {
        available: currentShopifyStock,
      });
    } catch (shopifyError) {
      log.warn('Impossible de récupérer le stock Shopify actuel', {
        error: shopifyError.message,
      });
    }

    // ============================================
    // Étape 4 : Mettre à jour Shopify si nécessaire
    // ============================================
    const newQuantity = stockData.quantity;

    // Vérifier si une mise à jour est nécessaire
    if (currentShopifyStock !== null && currentShopifyStock === newQuantity) {
      log.info('Stock identique - Aucune mise à jour nécessaire', {
        currentStock: currentShopifyStock,
        sageX3Stock: newQuantity,
      });

      syncStats.lastSuccess = new Date();
      syncStats.successCount++;

      return {
        success: true,
        updated: false,
        message: 'Stock identique - Aucune mise à jour',
        sageX3Stock: stockData,
        shopifyStock: currentShopifyStock,
        duration: Date.now() - startTime,
      };
    }

    // Mettre à jour le stock sur Shopify
    log.info('Mise à jour du stock Shopify', {
      previousStock: currentShopifyStock,
      newStock: newQuantity,
    });

    const updateResult = await shopifyService.updateInventoryLevel(newQuantity);

    log.info('Stock Shopify mis à jour avec succès', {
      inventoryItemId: config.shopify.inventoryItemId,
      previousStock: currentShopifyStock,
      newStock: newQuantity,
      difference: currentShopifyStock !== null ? newQuantity - currentShopifyStock : 'N/A',
    });

    // Mettre à jour les statistiques
    syncStats.lastSuccess = new Date();
    syncStats.successCount++;

    const duration = Date.now() - startTime;

    return {
      success: true,
      updated: true,
      message: 'Stock synchronisé avec succès',
      sageX3Stock: stockData,
      shopifyUpdate: updateResult,
      previousShopifyStock: currentShopifyStock,
      newShopifyStock: newQuantity,
      duration,
    };
  } catch (error) {
    // Mettre à jour les statistiques d'erreur
    syncStats.lastError = {
      date: new Date(),
      message: error.message,
    };
    syncStats.errorCount++;

    log.error('Erreur lors de la synchronisation du stock', {
      error: error.message,
      stack: error.stack,
      duration: Date.now() - startTime,
    });

    throw error;
  }
}

/**
 * Initialise et démarre le job de synchronisation
 *
 * @returns {CronJob} Instance du job cron
 */
function startStockSyncJob() {
  // Vérifier si le job est activé
  if (!config.stockSync.enabled) {
    log.info('Synchronisation automatique du stock désactivée');
    return null;
  }

  log.info('Démarrage du job de synchronisation du stock', {
    cronExpression: config.stockSync.cronExpression,
    timezone: 'Europe/Paris',
  });

  // Créer le job cron
  stockSyncJob = new CronJob(
    config.stockSync.cronExpression,
    async () => {
      try {
        await executeStockSync();
      } catch (error) {
        // L'erreur est déjà logguée dans executeStockSync
        // On ne la propage pas pour ne pas arrêter le cron
      }
    },
    null, // onComplete
    true, // start immédiatement
    'Europe/Paris' // timezone
  );

  log.info('Job de synchronisation du stock démarré', {
    nextRun: stockSyncJob.nextDate().toISO(),
  });

  return stockSyncJob;
}

/**
 * Arrête le job de synchronisation
 */
function stopStockSyncJob() {
  if (stockSyncJob) {
    stockSyncJob.stop();
    log.info('Job de synchronisation du stock arrêté');
    stockSyncJob = null;
  }
}

/**
 * Vérifie si le job est en cours d'exécution
 *
 * @returns {boolean} True si le job est actif
 */
function isJobRunning() {
  return stockSyncJob !== null && stockSyncJob.running;
}

/**
 * Récupère les statistiques de synchronisation
 *
 * @returns {Object} Statistiques du job
 */
function getStats() {
  return {
    ...syncStats,
    isRunning: isJobRunning(),
    nextRun: stockSyncJob ? stockSyncJob.nextDate().toISO() : null,
    cronExpression: config.stockSync.cronExpression,
  };
}

/**
 * Récupère la date de la prochaine exécution
 *
 * @returns {Date|null} Date de la prochaine exécution ou null si le job n'est pas actif
 */
function getNextRunDate() {
  if (!stockSyncJob) {
    return null;
  }
  return stockSyncJob.nextDate().toJSDate();
}

/**
 * Réinitialise les statistiques
 */
function resetStats() {
  syncStats.lastRun = null;
  syncStats.lastSuccess = null;
  syncStats.lastError = null;
  syncStats.successCount = 0;
  syncStats.errorCount = 0;
  syncStats.totalRuns = 0;

  log.info('Statistiques de synchronisation réinitialisées');
}

module.exports = {
  startStockSyncJob,
  stopStockSyncJob,
  executeStockSync,
  isJobRunning,
  getStats,
  getNextRunDate,
  resetStats,
};
