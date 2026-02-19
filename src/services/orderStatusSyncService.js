/**
 * Service de synchronisation des statuts de commandes
 *
 * Ce service gère la lecture des fichiers de statut depuis le dossier SFTP /out/
 * et met à jour les commandes Shopify en conséquence.
 *
 * Fonctionnement :
 * 1. Lit tous les fichiers .txt dans /out/
 * 2. Parse chaque fichier (référence commande + lignes produits avec statut)
 * 3. Détermine le statut global de la commande
 * 4. Met à jour le statut sur Shopify
 * 5. Archive ou supprime les fichiers traités
 *
 * Format attendu du fichier de statut (à adapter selon specs client) :
 * Ligne 1: REF_COMMANDE
 * Lignes suivantes: SKU|STATUT
 *
 * @module services/orderStatusSyncService
 */

const path = require('path');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');
const sftpService = require('./sftpService');
const shopifyService = require('./shopifyService');

// Logger dédié à ce module
const log = createModuleLogger('orderStatusSyncService');

/**
 * Mapping des statuts ERP vers les statuts Shopify
 * À adapter selon les valeurs réelles envoyées par l'ERP client
 */
const STATUS_MAPPING = {
  // Statuts ERP possibles (à confirmer avec le client)
  'EXPEDIE': 'fulfilled',
  'EXPEDIEE': 'fulfilled',
  'SHIPPED': 'fulfilled',
  'LIVRE': 'fulfilled',
  'LIVREE': 'fulfilled',
  'EN_PREPARATION': 'in_progress',
  'EN_COURS': 'in_progress',
  'PREPARING': 'in_progress',
  'ANNULE': 'cancelled',
  'ANNULEE': 'cancelled',
  'CANCELLED': 'cancelled',
  'RUPTURE': 'unfulfilled',
  'EN_ATTENTE': 'pending',
  'PENDING': 'pending',
};

/**
 * Parse un fichier de statut et extrait les informations
 *
 * Format attendu (à adapter selon specs client) :
 * Ligne 1: REF_COMMANDE (ex: SH1-1234)
 * Lignes suivantes: SKU|STATUT
 *
 * @param {string} content - Contenu du fichier
 * @param {string} fileName - Nom du fichier (pour les logs)
 * @returns {Object} { orderRef, lines: [{ sku, status }], rawContent }
 */
function parseStatusFile(content, fileName) {
  log.debug('Parsing du fichier de statut', { fileName });

  const lines = content.toString('utf-8').trim().split('\n');

  if (lines.length < 2) {
    throw new Error(`Fichier invalide (moins de 2 lignes): ${fileName}`);
  }

  // Première ligne = référence commande
  const orderRef = lines[0].trim();

  if (!orderRef) {
    throw new Error(`Référence commande vide dans le fichier: ${fileName}`);
  }

  // Lignes suivantes = SKU|STATUT
  const productLines = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) continue; // Ignorer les lignes vides

    const parts = line.split('|');

    if (parts.length < 2) {
      log.warn('Ligne de produit invalide ignorée', {
        fileName,
        lineNumber: i + 1,
        line,
      });
      continue;
    }

    const sku = parts[0].trim();
    const status = parts[1].trim().toUpperCase();

    productLines.push({
      sku,
      statusRaw: status,
      statusShopify: STATUS_MAPPING[status] || 'unknown',
    });
  }

  log.info('Fichier de statut parsé', {
    fileName,
    orderRef,
    lineCount: productLines.length,
  });

  return {
    orderRef,
    lines: productLines,
    rawContent: content.toString('utf-8'),
  };
}

/**
 * Détermine le statut global de la commande basé sur les statuts des lignes
 *
 * Logique :
 * - Si TOUTES les lignes sont "fulfilled" → commande fulfilled
 * - Si AU MOINS UNE ligne est "cancelled" et les autres "fulfilled" → partial
 * - Si TOUTES les lignes sont "cancelled" → cancelled
 * - Sinon → in_progress
 *
 * @param {Array} lines - Lignes de produits avec leurs statuts
 * @returns {string} Statut global de la commande
 */
function determineOrderStatus(lines) {
  if (!lines || lines.length === 0) {
    return 'unknown';
  }

  const statuses = lines.map((l) => l.statusShopify);

  const allFulfilled = statuses.every((s) => s === 'fulfilled');
  const allCancelled = statuses.every((s) => s === 'cancelled');
  const someFulfilled = statuses.some((s) => s === 'fulfilled');
  const someCancelled = statuses.some((s) => s === 'cancelled');

  if (allFulfilled) {
    return 'fulfilled';
  }

  if (allCancelled) {
    return 'cancelled';
  }

  if (someFulfilled && someCancelled) {
    return 'partial';
  }

  if (someFulfilled) {
    return 'in_progress';
  }

  return 'pending';
}

/**
 * Traite un fichier de statut individuel
 *
 * @param {string} fileName - Nom du fichier
 * @param {Buffer} content - Contenu du fichier
 * @returns {Promise<Object>} Résultat du traitement
 */
async function processStatusFile(fileName, content) {
  log.info('Traitement du fichier de statut', { fileName });

  try {
    // Parser le fichier
    const parsedData = parseStatusFile(content, fileName);

    // Déterminer le statut global
    const orderStatus = determineOrderStatus(parsedData.lines);

    log.info('Statut de commande déterminé', {
      orderRef: parsedData.orderRef,
      lineCount: parsedData.lines.length,
      orderStatus,
      lineStatuses: parsedData.lines.map((l) => `${l.sku}: ${l.statusRaw}`),
    });

    // TODO: Mettre à jour la commande sur Shopify
    // Cette partie sera implémentée une fois qu'on aura confirmé le format du fichier
    // et les actions à effectuer sur Shopify

    let shopifyUpdateResult = null;

    if (orderStatus === 'fulfilled') {
      // Marquer la commande comme expédiée sur Shopify
      try {
        shopifyUpdateResult = await shopifyService.fulfillOrder(parsedData.orderRef);
      } catch (shopifyError) {
        log.error('Erreur mise à jour Shopify', {
          orderRef: parsedData.orderRef,
          error: shopifyError.message,
        });
        shopifyUpdateResult = { success: false, error: shopifyError.message };
      }
    }

    return {
      success: true,
      fileName,
      orderRef: parsedData.orderRef,
      lineCount: parsedData.lines.length,
      orderStatus,
      lines: parsedData.lines,
      shopifyUpdate: shopifyUpdateResult,
    };
  } catch (error) {
    log.error('Erreur lors du traitement du fichier de statut', {
      fileName,
      error: error.message,
    });

    return {
      success: false,
      fileName,
      error: error.message,
    };
  }
}

/**
 * Archive un fichier traité en le déplaçant vers le dossier d'archive
 *
 * @param {string} fileName - Nom du fichier à archiver
 * @returns {Promise<Object>} Résultat de l'archivage
 */
async function archiveFile(fileName) {
  const sourcePath = path.posix.join(config.sftp.remoteDirOut, fileName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFileName = `${path.basename(fileName, '.txt')}_${timestamp}.txt`;
  const destPath = path.posix.join(config.statusSync.archiveDir, archiveFileName);

  log.info('Archivage du fichier', { sourcePath, destPath });

  try {
    await sftpService.moveFile(sourcePath, destPath);

    return {
      success: true,
      sourcePath,
      destPath,
    };
  } catch (error) {
    log.error('Erreur lors de l\'archivage', {
      fileName,
      error: error.message,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Supprime un fichier traité
 *
 * @param {string} fileName - Nom du fichier à supprimer
 * @returns {Promise<Object>} Résultat de la suppression
 */
async function deleteProcessedFile(fileName) {
  log.info('Suppression du fichier traité', { fileName });

  try {
    await sftpService.deleteFile(fileName, config.sftp.remoteDirOut);

    return {
      success: true,
      fileName,
    };
  } catch (error) {
    log.error('Erreur lors de la suppression', {
      fileName,
      error: error.message,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Synchronise tous les fichiers de statut depuis le dossier /out/
 *
 * Cette fonction :
 * 1. Liste tous les fichiers .txt dans /out/
 * 2. Télécharge et traite chaque fichier
 * 3. Archive ou supprime les fichiers traités (selon config)
 *
 * @returns {Promise<Object>} Résumé de la synchronisation
 */
async function syncAllStatusFiles() {
  const startTime = Date.now();

  log.info('Début de la synchronisation des statuts de commandes', {
    remoteDirOut: config.sftp.remoteDirOut,
    archiveEnabled: config.statusSync.archiveProcessed,
  });

  const results = {
    success: true,
    startTime: new Date().toISOString(),
    filesFound: 0,
    filesProcessed: 0,
    filesSuccess: 0,
    filesFailed: 0,
    filesArchived: 0,
    details: [],
    errors: [],
  };

  try {
    // 1. Lister les fichiers dans /out/
    const files = await sftpService.listFiles(config.sftp.remoteDirOut);

    // Filtrer uniquement les fichiers .txt
    const txtFiles = files.filter(
      (f) => f.type === 'fichier' && f.name.toLowerCase().endsWith('.txt')
    );

    results.filesFound = txtFiles.length;

    log.info('Fichiers de statut trouvés', {
      total: files.length,
      txtFiles: txtFiles.length,
    });

    if (txtFiles.length === 0) {
      log.info('Aucun fichier de statut à traiter');
      results.message = 'Aucun fichier de statut à traiter';
      return results;
    }

    // 2. Traiter chaque fichier
    for (const file of txtFiles) {
      results.filesProcessed++;

      try {
        // Télécharger le fichier
        const content = await sftpService.downloadFile(file.name, config.sftp.remoteDirOut);

        // Traiter le fichier
        const processResult = await processStatusFile(file.name, content);

        results.details.push(processResult);

        if (processResult.success) {
          results.filesSuccess++;

          // 3. Archiver ou supprimer le fichier traité
          if (config.statusSync.archiveProcessed) {
            const archiveResult = await archiveFile(file.name);
            if (archiveResult.success) {
              results.filesArchived++;
            }
          } else {
            await deleteProcessedFile(file.name);
          }
        } else {
          results.filesFailed++;
          results.errors.push({
            fileName: file.name,
            error: processResult.error,
          });
        }
      } catch (fileError) {
        results.filesFailed++;
        results.errors.push({
          fileName: file.name,
          error: fileError.message,
        });

        log.error('Erreur lors du traitement du fichier', {
          fileName: file.name,
          error: fileError.message,
        });
      }
    }
  } catch (error) {
    results.success = false;
    results.error = error.message;

    log.error('Erreur lors de la synchronisation des statuts', {
      error: error.message,
    });
  }

  results.endTime = new Date().toISOString();
  results.durationMs = Date.now() - startTime;

  log.info('Synchronisation des statuts terminée', {
    filesFound: results.filesFound,
    filesProcessed: results.filesProcessed,
    filesSuccess: results.filesSuccess,
    filesFailed: results.filesFailed,
    durationMs: results.durationMs,
  });

  return results;
}

/**
 * Prévisualise les fichiers de statut sans les traiter
 * Utile pour vérifier le contenu avant de lancer la synchronisation
 *
 * @returns {Promise<Object>} Liste des fichiers avec leur contenu parsé
 */
async function previewStatusFiles() {
  log.info('Prévisualisation des fichiers de statut');

  const results = {
    success: true,
    remoteDirOut: config.sftp.remoteDirOut,
    files: [],
  };

  try {
    // Lister les fichiers dans /out/
    const files = await sftpService.listFiles(config.sftp.remoteDirOut);

    // Filtrer uniquement les fichiers .txt
    const txtFiles = files.filter(
      (f) => f.type === 'fichier' && f.name.toLowerCase().endsWith('.txt')
    );

    for (const file of txtFiles) {
      try {
        const content = await sftpService.downloadFile(file.name, config.sftp.remoteDirOut);
        const parsedData = parseStatusFile(content, file.name);
        const orderStatus = determineOrderStatus(parsedData.lines);

        results.files.push({
          fileName: file.name,
          size: file.size,
          modifyTime: file.modifyTime,
          orderRef: parsedData.orderRef,
          lineCount: parsedData.lines.length,
          orderStatus,
          lines: parsedData.lines,
          rawContent: parsedData.rawContent,
        });
      } catch (parseError) {
        results.files.push({
          fileName: file.name,
          size: file.size,
          modifyTime: file.modifyTime,
          error: parseError.message,
        });
      }
    }
  } catch (error) {
    results.success = false;
    results.error = error.message;
  }

  return results;
}

module.exports = {
  syncAllStatusFiles,
  previewStatusFiles,
  processStatusFile,
  parseStatusFile,
  determineOrderStatus,
  archiveFile,
  STATUS_MAPPING,
};
