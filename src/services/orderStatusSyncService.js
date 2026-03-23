/**
 * Service de synchronisation des statuts de commandes
 *
 * Ce service gère la lecture des fichiers de statut depuis le dossier SFTP /out/
 * et met à jour les commandes Shopify en conséquence.
 *
 * Fonctionnement :
 * 1. Lit tous les fichiers .txt dans /out/
 * 2. Parse chaque fichier CSV (format Sage X3)
 * 3. Groupe les lignes par commande
 * 4. Détermine le statut global (basé sur QuantiteRestante)
 * 5. Met à jour le statut sur Shopify + ajoute une note
 * 6. Archive ou supprime les fichiers traités
 *
 * Format du fichier CSV Sage X3 :
 * - Séparateur : ; (point-virgule)
 * - Première ligne : En-tête avec noms de colonnes
 * - Colonnes : NumCmd;NumLigneBL;NumLigneCmd;QuantiteRestante;QuantiteLivree;QuantiteCommandee;Article;NumBl;NumCmdX3
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
 * Noms des colonnes attendues dans le fichier CSV
 */
const CSV_COLUMNS = {
  NUM_CMD: 0,           // Référence commande Shopify (ex: SH1-1013)
  NUM_LIGNE_BL: 1,      // Numéro de ligne du Bon de Livraison
  NUM_LIGNE_CMD: 2,     // Numéro de ligne de la commande
  QTE_RESTANTE: 3,      // Quantité restant à livrer (0 = tout livré)
  QTE_LIVREE: 4,        // Quantité déjà livrée
  QTE_COMMANDEE: 5,     // Quantité commandée
  ARTICLE: 6,           // Code article Sage X3
  NUM_BL: 7,            // Numéro du Bon de Livraison Sage
  NUM_CMD_X3: 8,        // Numéro de commande Sage X3
};

/**
 * Parse un fichier CSV de statut Sage X3
 *
 * @param {string|Buffer} content - Contenu du fichier
 * @param {string} fileName - Nom du fichier (pour les logs)
 * @returns {Object} { orders: Map<orderRef, orderData>, rawContent }
 */
function parseStatusFile(content, fileName) {
  log.debug('Parsing du fichier de statut CSV', { fileName });

  const contentStr = content.toString('utf-8');
  // Gérer les retours à la ligne Windows (CRLF) et Unix (LF)
  const lines = contentStr.trim().split(/\r?\n/);

  if (lines.length < 2) {
    throw new Error(`Fichier invalide (moins de 2 lignes): ${fileName}`);
  }

  // Première ligne = en-tête (on la vérifie mais on ne l'utilise pas)
  const header = lines[0].trim();
  log.debug('En-tête du fichier CSV', { header });

  // Map pour grouper les lignes par commande
  const ordersMap = new Map();

  // Parser les lignes de données (à partir de la ligne 2)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) continue; // Ignorer les lignes vides

    const parts = line.split(';');

    if (parts.length < 9) {
      log.warn('Ligne CSV invalide ignorée (moins de 9 colonnes)', {
        fileName,
        lineNumber: i + 1,
        line,
        columnsFound: parts.length,
      });
      continue;
    }

    // Extraire les données de la ligne
    const lineData = {
      numCmd: parts[CSV_COLUMNS.NUM_CMD]?.trim(),
      numLigneBL: parts[CSV_COLUMNS.NUM_LIGNE_BL]?.trim(),
      numLigneCmd: parts[CSV_COLUMNS.NUM_LIGNE_CMD]?.trim(),
      qteRestante: parseInt(parts[CSV_COLUMNS.QTE_RESTANTE], 10) || 0,
      qteLivree: parseInt(parts[CSV_COLUMNS.QTE_LIVREE], 10) || 0,
      qteCommandee: parseInt(parts[CSV_COLUMNS.QTE_COMMANDEE], 10) || 0,
      article: parts[CSV_COLUMNS.ARTICLE]?.trim(),
      numBL: parts[CSV_COLUMNS.NUM_BL]?.trim(),
      numCmdX3: parts[CSV_COLUMNS.NUM_CMD_X3]?.trim(),
    };

    if (!lineData.numCmd) {
      log.warn('Ligne sans référence commande ignorée', {
        fileName,
        lineNumber: i + 1,
      });
      continue;
    }

    // Ajouter la ligne à la commande correspondante
    if (!ordersMap.has(lineData.numCmd)) {
      ordersMap.set(lineData.numCmd, {
        orderRef: lineData.numCmd,
        lines: [],
        numBL: lineData.numBL,       // Prendre le premier NumBL trouvé
        numCmdX3: lineData.numCmdX3, // Prendre le premier NumCmdX3 trouvé
      });
    }

    const orderData = ordersMap.get(lineData.numCmd);
    orderData.lines.push(lineData);

    // Mettre à jour NumBL et NumCmdX3 si pas encore défini
    if (!orderData.numBL && lineData.numBL) {
      orderData.numBL = lineData.numBL;
    }
    if (!orderData.numCmdX3 && lineData.numCmdX3) {
      orderData.numCmdX3 = lineData.numCmdX3;
    }
  }

  log.info('Fichier de statut CSV parsé', {
    fileName,
    ordersFound: ordersMap.size,
    totalLines: lines.length - 1,
  });

  return {
    orders: ordersMap,
    rawContent: contentStr,
    header,
  };
}

/**
 * Détermine le statut global d'une commande basé sur QuantiteRestante
 *
 * Logique :
 * - Si TOUTES les lignes ont QuantiteRestante = 0 → fulfilled (totalement expédiée)
 * - Si CERTAINES lignes ont QuantiteRestante > 0 → partial (partiellement expédiée)
 * - Si TOUTES les lignes ont QuantiteRestante > 0 et QteLivree = 0 → pending (en attente)
 *
 * @param {Array} lines - Lignes de la commande
 * @returns {Object} { status, fulfilledLines, pendingLines, totalQteRestante }
 */
function determineOrderStatus(lines) {
  if (!lines || lines.length === 0) {
    return {
      status: 'unknown',
      fulfilledLines: 0,
      pendingLines: 0,
      totalQteRestante: 0,
    };
  }

  let fulfilledLines = 0;
  let pendingLines = 0;
  let totalQteRestante = 0;
  let totalQteLivree = 0;

  for (const line of lines) {
    totalQteRestante += line.qteRestante;
    totalQteLivree += line.qteLivree;

    if (line.qteRestante === 0) {
      fulfilledLines++;
    } else {
      pendingLines++;
    }
  }

  let status;

  if (fulfilledLines === lines.length) {
    // Toutes les lignes sont complètement livrées
    status = 'fulfilled';
  } else if (totalQteLivree > 0) {
    // Au moins une partie a été livrée
    status = 'partial';
  } else {
    // Rien n'a été livré encore
    status = 'pending';
  }

  return {
    status,
    fulfilledLines,
    pendingLines,
    totalLines: lines.length,
    totalQteRestante,
    totalQteLivree,
  };
}

/**
 * Génère le texte de la note à ajouter sur Shopify
 *
 * @param {Object} orderData - Données de la commande
 * @param {Object} statusInfo - Informations de statut
 * @returns {string} Texte de la note
 */
function generateOrderNote(orderData, statusInfo) {
  const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  let noteLines = [
    `══════════════════════════════════`,
    `📦 MISE À JOUR SAGE X3 - ${now}`,
    `══════════════════════════════════`,
    ``,
    `🔹 N° Bon de Livraison : ${orderData.numBL || 'N/A'}`,
    `🔹 N° Commande Sage X3 : ${orderData.numCmdX3 || 'N/A'}`,
    ``,
    `📊 STATUT : ${statusInfo.status === 'fulfilled' ? '✅ EXPÉDIÉE' : statusInfo.status === 'partial' ? '⚠️ PARTIELLE' : '⏳ EN ATTENTE'}`,
    ``,
    `📋 DÉTAIL DES LIGNES :`,
  ];

  for (const line of orderData.lines) {
    const lineStatus = line.qteRestante === 0 ? '✅' : '⏳';
    noteLines.push(
      `   ${lineStatus} ${line.article} : ${line.qteLivree}/${line.qteCommandee} livré(s) (reste: ${line.qteRestante})`
    );
  }

  noteLines.push(``);
  noteLines.push(`══════════════════════════════════`);

  return noteLines.join('\n');
}

/**
 * Traite toutes les commandes d'un fichier de statut
 *
 * @param {string} fileName - Nom du fichier
 * @param {Buffer} content - Contenu du fichier
 * @returns {Promise<Object>} Résultat du traitement
 */
async function processStatusFile(fileName, content) {
  log.info('Traitement du fichier de statut', { fileName });

  const results = {
    success: true,
    fileName,
    ordersProcessed: 0,
    ordersSuccess: 0,
    ordersFailed: 0,
    orders: [],
  };

  try {
    // Parser le fichier CSV
    const parsedData = parseStatusFile(content, fileName);

    // Traiter chaque commande
    for (const [orderRef, orderData] of parsedData.orders) {
      const orderResult = {
        orderRef,
        numBL: orderData.numBL,
        numCmdX3: orderData.numCmdX3,
        lineCount: orderData.lines.length,
      };

      try {
        // Déterminer le statut
        const statusInfo = determineOrderStatus(orderData.lines);
        orderResult.status = statusInfo.status;
        orderResult.statusInfo = statusInfo;

        log.info('Statut de commande déterminé', {
          orderRef,
          status: statusInfo.status,
          fulfilledLines: statusInfo.fulfilledLines,
          pendingLines: statusInfo.pendingLines,
        });

        // Générer la note pour Shopify
        const note = generateOrderNote(orderData, statusInfo);
        orderResult.note = note;

        // Mettre à jour Shopify
        let shopifyResult = { success: true, actions: [] };

        // 1. Ajouter la note sur la commande
        try {
          const noteResult = await shopifyService.addOrderNote(orderRef, note);
          shopifyResult.actions.push({
            action: 'addNote',
            success: noteResult.success,
            error: noteResult.error,
          });
        } catch (noteError) {
          log.error('Erreur ajout note Shopify', {
            orderRef,
            error: noteError.message,
          });
          shopifyResult.actions.push({
            action: 'addNote',
            success: false,
            error: noteError.message,
          });
        }

        // 2. Si totalement expédiée, marquer comme fulfilled
        if (statusInfo.status === 'fulfilled') {
          try {
            const fulfillResult = await shopifyService.fulfillOrder(orderRef, {
              notifyCustomer: true,
            });
            shopifyResult.actions.push({
              action: 'fulfill',
              success: fulfillResult.success,
              alreadyFulfilled: fulfillResult.alreadyFulfilled,
              error: fulfillResult.error,
            });
          } catch (fulfillError) {
            log.error('Erreur fulfillment Shopify', {
              orderRef,
              error: fulfillError.message,
            });
            shopifyResult.actions.push({
              action: 'fulfill',
              success: false,
              error: fulfillError.message,
            });
          }
        }

        orderResult.shopifyUpdate = shopifyResult;
        orderResult.success = shopifyResult.actions.every(a => a.success || a.alreadyFulfilled);

        if (orderResult.success) {
          results.ordersSuccess++;
        } else {
          results.ordersFailed++;
        }
      } catch (orderError) {
        log.error('Erreur traitement commande', {
          orderRef,
          error: orderError.message,
        });
        orderResult.success = false;
        orderResult.error = orderError.message;
        results.ordersFailed++;
      }

      results.ordersProcessed++;
      results.orders.push(orderResult);
    }
  } catch (error) {
    log.error('Erreur lors du traitement du fichier de statut', {
      fileName,
      error: error.message,
    });

    results.success = false;
    results.error = error.message;
  }

  return results;
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
    totalOrdersProcessed: 0,
    totalOrdersSuccess: 0,
    totalOrdersFailed: 0,
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
        results.totalOrdersProcessed += processResult.ordersProcessed;
        results.totalOrdersSuccess += processResult.ordersSuccess;
        results.totalOrdersFailed += processResult.ordersFailed;

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
    totalOrdersProcessed: results.totalOrdersProcessed,
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

        // Convertir la Map en tableau pour la sérialisation JSON
        const ordersArray = [];
        for (const [orderRef, orderData] of parsedData.orders) {
          const statusInfo = determineOrderStatus(orderData.lines);
          ordersArray.push({
            orderRef,
            numBL: orderData.numBL,
            numCmdX3: orderData.numCmdX3,
            lineCount: orderData.lines.length,
            status: statusInfo.status,
            statusInfo,
            lines: orderData.lines,
            notePreview: generateOrderNote(orderData, statusInfo),
          });
        }

        results.files.push({
          fileName: file.name,
          size: file.size,
          modifyTime: file.modifyTime,
          ordersCount: parsedData.orders.size,
          orders: ordersArray,
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

  results.timestamp = new Date().toISOString();

  return results;
}

module.exports = {
  syncAllStatusFiles,
  previewStatusFiles,
  processStatusFile,
  parseStatusFile,
  determineOrderStatus,
  generateOrderNote,
  archiveFile,
  CSV_COLUMNS,
};
