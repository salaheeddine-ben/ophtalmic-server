/**
 * Job de synchronisation des statuts de commandes
 * Cron job pour synchroniser les statuts depuis SFTP /out/ vers Shopify
 *
 * Ce module configure et exécute un job planifié (cron) qui :
 * 1. Lit les fichiers de statut dans le dossier SFTP /out/
 * 2. Parse chaque fichier pour extraire le statut des commandes
 * 3. Met à jour les commandes sur Shopify (fulfilled, etc.)
 * 4. Archive ou supprime les fichiers traités
 *
 * Par défaut, le job s'exécute 2 fois par jour à 8h et 18h (configurable via STATUS_SYNC_CRON).
 *
 * @module jobs/statusSyncJob
 */

const { CronJob } = require('cron');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');
const orderStatusSyncService = require('../services/orderStatusSyncService');

// Logger dédié à la synchronisation des statuts
const log = createModuleLogger('statusSyncJob');

// Référence au job cron (pour pouvoir l'arrêter si nécessaire)
let statusSyncJob = null;

// Statistiques de synchronisation
const syncStats = {
  lastRun: null,
  lastSuccess: null,
  lastError: null,
  successCount: 0,
  errorCount: 0,
  totalRuns: 0,
  totalFilesProcessed: 0,
  totalOrdersUpdated: 0,
};

/**
 * Exécute la synchronisation des statuts de commandes
 *
 * Cette fonction est appelée par le job cron ou manuellement.
 *
 * @returns {Promise<Object>} Résultat de la synchronisation
 */
async function executeStatusSync() {
  const startTime = Date.now();
  syncStats.totalRuns++;
  syncStats.lastRun = new Date();

  log.info('Début de la synchronisation des statuts de commandes', {
    remoteDirOut: config.sftp.remoteDirOut,
    runNumber: syncStats.totalRuns,
  });

  try {
    // Exécuter la synchronisation
    const result = await orderStatusSyncService.syncAllStatusFiles();

    if (result.success) {
      syncStats.lastSuccess = new Date();
      syncStats.successCount++;
      syncStats.totalFilesProcessed += result.filesProcessed || 0;
      syncStats.totalOrdersUpdated += result.filesSuccess || 0;

      log.info('Synchronisation des statuts terminée avec succès', {
        filesFound: result.filesFound,
        filesProcessed: result.filesProcessed,
        filesSuccess: result.filesSuccess,
        filesFailed: result.filesFailed,
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
    // Mettre à jour les statistiques d'erreur
    syncStats.lastError = {
      date: new Date(),
      message: error.message,
    };
    syncStats.errorCount++;

    log.error('Erreur lors de la synchronisation des statuts', {
      error: error.message,
      stack: error.stack,
      duration: Date.now() - startTime,
    });

    throw error;
  }
}

/**
 * Initialise et démarre le job de synchronisation des statuts
 *
 * @returns {CronJob} Instance du job cron
 */
function startStatusSyncJob() {
  // Vérifier si le job est activé
  if (!config.statusSync.enabled) {
    log.info('Synchronisation automatique des statuts désactivée');
    return null;
  }

  log.info('Démarrage du job de synchronisation des statuts', {
    cronExpression: config.statusSync.cronExpression,
    timezone: 'Europe/Paris',
    remoteDirOut: config.sftp.remoteDirOut,
    archiveEnabled: config.statusSync.archiveProcessed,
  });

  // Créer le job cron
  statusSyncJob = new CronJob(
    config.statusSync.cronExpression,
    async () => {
      try {
        await executeStatusSync();
      } catch (error) {
        // L'erreur est déjà logguée dans executeStatusSync
        // On ne la propage pas pour ne pas arrêter le cron
      }
    },
    null, // onComplete
    true, // start immédiatement
    'Europe/Paris' // timezone
  );

  log.info('Job de synchronisation des statuts démarré', {
    nextRun: statusSyncJob.nextDate().toISO(),
  });

  return statusSyncJob;
}

/**
 * Arrête le job de synchronisation des statuts
 */
function stopStatusSyncJob() {
  if (statusSyncJob) {
    statusSyncJob.stop();
    log.info('Job de synchronisation des statuts arrêté');
    statusSyncJob = null;
  }
}

/**
 * Vérifie si le job est en cours d'exécution
 *
 * @returns {boolean} True si le job est actif
 */
function isJobRunning() {
  return statusSyncJob !== null && statusSyncJob.running;
}

/**
 * Récupère les statistiques de synchronisation des statuts
 *
 * @returns {Object} Statistiques du job
 */
function getStats() {
  return {
    ...syncStats,
    isRunning: isJobRunning(),
    nextRun: statusSyncJob ? statusSyncJob.nextDate().toISO() : null,
    cronExpression: config.statusSync.cronExpression,
    remoteDirOut: config.sftp.remoteDirOut,
    archiveEnabled: config.statusSync.archiveProcessed,
  };
}

/**
 * Récupère la date de la prochaine exécution
 *
 * @returns {Date|null} Date de la prochaine exécution ou null si le job n'est pas actif
 */
function getNextRunDate() {
  if (!statusSyncJob) {
    return null;
  }
  return statusSyncJob.nextDate().toJSDate();
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
  syncStats.totalFilesProcessed = 0;
  syncStats.totalOrdersUpdated = 0;

  log.info('Statistiques de synchronisation des statuts réinitialisées');
}

module.exports = {
  startStatusSyncJob,
  stopStatusSyncJob,
  executeStatusSync,
  isJobRunning,
  getStats,
  getNextRunDate,
  resetStats,
};
