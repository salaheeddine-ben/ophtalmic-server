/**
 * Job d'export automatique des transactions bancaires
 * Cron job pour exporter les payouts Shopify vers Sage X3
 *
 * Ce module configure et exécute un job planifié (cron) qui :
 * 1. Récupère les payouts "paid" de Shopify Payments
 * 2. Génère les fichiers TXT pour chaque nouveau payout
 * 3. Envoie les fichiers sur le serveur SFTP dans /Transactions/
 *
 * Par défaut, le job s'exécute 1 fois par jour à 6h (configurable via TRANSACTION_EXPORT_CRON).
 *
 * @module jobs/transactionSyncJob
 */

const { CronJob } = require('cron');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');
const transactionExportService = require('../services/transactionExportService');

const log = createModuleLogger('transactionSyncJob');

// Référence au job cron
let transactionSyncJob = null;

// Statistiques
const syncStats = {
  lastRun: null,
  lastSuccess: null,
  lastError: null,
  successCount: 0,
  errorCount: 0,
  totalRuns: 0,
  totalPayoutsExported: 0,
};

/**
 * Exécute l'export des transactions
 *
 * @returns {Promise<Object>} Résultat de l'export
 */
async function executeTransactionExport() {
  const startTime = Date.now();
  syncStats.totalRuns++;
  syncStats.lastRun = new Date();

  log.info('Début de l\'export automatique des transactions', {
    runNumber: syncStats.totalRuns,
  });

  try {
    const result = await transactionExportService.exportAllPendingPayouts({
      limit: 20,
      testMode: config.test.testMode,
    });

    if (result.success) {
      syncStats.lastSuccess = new Date();
      syncStats.successCount++;
      syncStats.totalPayoutsExported += result.exported;

      log.info('Export des transactions terminé avec succès', {
        exported: result.exported,
        skipped: result.skipped,
        failed: result.failed,
        duration: Date.now() - startTime,
      });
    } else {
      throw new Error(result.error || 'Erreur inconnue');
    }

    return {
      success: true,
      ...result,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    syncStats.lastError = {
      date: new Date(),
      message: error.message,
    };
    syncStats.errorCount++;

    log.error('Erreur lors de l\'export des transactions', {
      error: error.message,
      stack: error.stack,
      duration: Date.now() - startTime,
    });

    throw error;
  }
}

/**
 * Initialise et démarre le job d'export des transactions
 *
 * @returns {CronJob} Instance du job cron
 */
function startTransactionSyncJob() {
  if (!config.transactionExport.enabled) {
    log.info('Export automatique des transactions désactivé');
    return null;
  }

  log.info('Démarrage du job d\'export des transactions', {
    cronExpression: config.transactionExport.cronExpression,
    timezone: 'Europe/Paris',
    remoteDirTransactions: config.sftp.remoteDirTransactions,
  });

  transactionSyncJob = new CronJob(
    config.transactionExport.cronExpression,
    async () => {
      try {
        await executeTransactionExport();
      } catch (error) {
        // L'erreur est déjà loggée dans executeTransactionExport
      }
    },
    null,
    true,
    'Europe/Paris'
  );

  log.info('Job d\'export des transactions démarré', {
    nextRun: transactionSyncJob.nextDate().toISO(),
  });

  return transactionSyncJob;
}

/**
 * Arrête le job d'export des transactions
 */
function stopTransactionSyncJob() {
  if (transactionSyncJob) {
    transactionSyncJob.stop();
    log.info('Job d\'export des transactions arrêté');
    transactionSyncJob = null;
  }
}

/**
 * Vérifie si le job est en cours d'exécution
 *
 * @returns {boolean} True si le job est actif
 */
function isJobRunning() {
  return transactionSyncJob !== null && transactionSyncJob.running;
}

/**
 * Récupère les statistiques du job
 *
 * @returns {Object} Statistiques
 */
function getStats() {
  return {
    ...syncStats,
    isRunning: isJobRunning(),
    nextRun: transactionSyncJob ? transactionSyncJob.nextDate().toISO() : null,
    cronExpression: config.transactionExport.cronExpression,
    remoteDirTransactions: config.sftp.remoteDirTransactions,
    testMode: config.test.testMode,
  };
}

/**
 * Récupère la date de la prochaine exécution
 *
 * @returns {Date|null} Date de la prochaine exécution
 */
function getNextRunDate() {
  if (!transactionSyncJob) {
    return null;
  }
  return transactionSyncJob.nextDate().toJSDate();
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
  syncStats.totalPayoutsExported = 0;

  log.info('Statistiques d\'export des transactions réinitialisées');
}

module.exports = {
  startTransactionSyncJob,
  stopTransactionSyncJob,
  executeTransactionExport,
  isJobRunning,
  getStats,
  getNextRunDate,
  resetStats,
};
