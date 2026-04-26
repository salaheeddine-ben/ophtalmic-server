/**
 * Service d'export des transactions bancaires
 *
 * Ce service gère l'export des virements Shopify Payments vers Sage X3.
 * Il génère des fichiers TXT contenant les informations de paiement
 * pour le service comptabilité.
 *
 * Format du fichier :
 * - ENTETE : Date versement, Ref bancaire, Montant total, Montant HT frais, Frais
 * - LIGNES : Date commande, N° commande, Montant brut, Frais, Montant net
 *
 * @module services/transactionExportService
 */

const fs = require('fs').promises;
const path = require('path');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');
const sftpService = require('./sftpService');
const shopifyService = require('./shopifyService');

const log = createModuleLogger('transactionExportService');

// Stockage des payouts déjà exportés (en mémoire - reset au redémarrage)
// En production, utiliser une base de données ou un fichier persistant
const exportedPayouts = new Set();

/**
 * Charge les payouts déjà exportés depuis un fichier local
 * Permet de persister entre les redémarrages
 */
async function loadExportedPayouts() {
  const filePath = path.join(config.test.localDownloadDir, '.exported_payouts.json');

  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const payoutIds = JSON.parse(data);
    payoutIds.forEach((id) => exportedPayouts.add(id));
    log.info('Payouts exportés chargés', { count: exportedPayouts.size });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log.warn('Erreur chargement payouts exportés', { error: error.message });
    }
  }
}

/**
 * Sauvegarde les payouts déjà exportés dans un fichier local
 */
async function saveExportedPayouts() {
  const filePath = path.join(config.test.localDownloadDir, '.exported_payouts.json');

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify([...exportedPayouts]), 'utf-8');
  } catch (error) {
    log.warn('Erreur sauvegarde payouts exportés', { error: error.message });
  }
}

/**
 * Vérifie si un payout a déjà été exporté
 *
 * @param {string} payoutId - ID du payout
 * @returns {boolean} True si déjà exporté
 */
function isPayoutExported(payoutId) {
  return exportedPayouts.has(String(payoutId));
}

/**
 * Marque un payout comme exporté
 *
 * @param {string} payoutId - ID du payout
 */
async function markPayoutAsExported(payoutId) {
  exportedPayouts.add(String(payoutId));
  await saveExportedPayouts();
}

/**
 * Formate une date au format AAAA-MM-JJ
 *
 * @param {string|Date} date - Date à formater
 * @returns {string} Date formatée
 */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

/**
 * Formate un montant avec 2 décimales
 *
 * @param {number|string} amount - Montant à formater
 * @returns {string} Montant formaté
 */
function formatAmount(amount) {
  const num = parseFloat(amount) || 0;
  return num.toFixed(2);
}

/**
 * Génère le contenu du fichier TXT pour un payout
 *
 * Format :
 * ENTETE
 * Date versement|Ref bancaire|Montant total|Montant sans frais|Frais totaux
 *
 * LIGNES
 * Date commande|N° commande|Montant brut|Frais|Montant net
 *
 * @param {Object} payout - Données du payout
 * @param {Array} transactions - Transactions du payout (avec orderName enrichi)
 * @returns {string} Contenu du fichier TXT
 */
function generateTransactionFileContent(payout, transactions) {
  log.info('Génération du fichier de transaction', {
    payoutId: payout.id,
    transactionCount: transactions.length,
  });

  // Calculer les totaux
  let totalGross = 0;
  let totalFee = 0;
  let totalNet = 0;

  // Filtrer les transactions de type "charge" (commandes)
  const orderTransactions = transactions.filter((t) => t.type === 'charge');

  for (const t of orderTransactions) {
    totalGross += parseFloat(t.amount) || 0;
    totalFee += parseFloat(t.fee) || 0;
    totalNet += parseFloat(t.net) || 0;
  }

  // Référence bancaire : utiliser bank_reference si disponible, sinon l'ID
  const bankReference = payout.bank_reference || payout.id || 'N/A';

  // ============================================
  // Construire la section ENTETE
  // ============================================
  const headerLines = [
    'ENTETE',
    [
      formatDate(payout.date),           // Date de versement
      bankReference,                      // Référence bancaire
      formatAmount(payout.amount),        // Montant total versé
      formatAmount(totalGross),           // Montant total sans frais
      formatAmount(totalFee),             // Frais totaux
    ].join('|'),
  ];

  // ============================================
  // Construire la section LIGNES
  // ============================================
  const itemLines = ['LIGNES'];

  for (const transaction of orderTransactions) {
    // Utiliser le nom de commande enrichi (ex: SH1-1020) ou fallback sur l'ID
    const orderNumber = transaction.orderName || `#${transaction.source_order_id || transaction.source_id || 'N/A'}`;

    const line = [
      formatDate(transaction.processed_at),  // Date de commande
      orderNumber,                            // N° commande Shopify (ex: SH1-1020)
      formatAmount(transaction.amount),       // Montant brut HT frais
      formatAmount(transaction.fee),          // Montant des frais
      formatAmount(transaction.net),          // Montant net après frais
    ].join('|');

    itemLines.push(line);
  }

  // ============================================
  // Assembler le fichier complet
  // ============================================
  const fileContent = [...headerLines, '', ...itemLines].join('\n');

  log.debug('Contenu du fichier généré', {
    payoutId: payout.id,
    bankReference,
    lineCount: orderTransactions.length,
    totalGross,
    totalFee,
    totalNet,
  });

  return fileContent;
}

/**
 * Enrichit les transactions avec les noms de commandes
 *
 * @param {Array} transactions - Transactions brutes
 * @returns {Promise<Array>} Transactions avec orderName ajouté
 */
async function enrichTransactionsWithOrderNames(transactions) {
  log.info('Enrichissement des transactions avec noms de commandes', {
    count: transactions.length,
  });

  const enrichedTransactions = [];

  for (const transaction of transactions) {
    const enriched = { ...transaction };

    // Si c'est une charge avec un source_order_id, récupérer le nom
    if (transaction.type === 'charge' && transaction.source_order_id) {
      try {
        const orderName = await shopifyService.getOrderNameById(transaction.source_order_id);
        enriched.orderName = orderName;
      } catch (error) {
        log.warn('Impossible de récupérer le nom de commande', {
          orderId: transaction.source_order_id,
          error: error.message,
        });
        enriched.orderName = `#${transaction.source_order_id}`;
      }
    }

    enrichedTransactions.push(enriched);
  }

  return enrichedTransactions;
}

/**
 * Génère le nom du fichier pour un payout
 *
 * Format: TRANSACTION_[DATE]_[REF_BANCAIRE].txt
 *
 * @param {Object} payout - Données du payout
 * @returns {string} Nom du fichier
 */
function generateFileName(payout) {
  const date = formatDate(payout.date).replace(/-/g, '');
  // Utiliser la référence bancaire si disponible, sinon l'ID
  const ref = String(payout.bank_reference || payout.id).replace(/[^a-zA-Z0-9]/g, '');
  return `TRANSACTION_${date}_${ref}.txt`;
}

/**
 * Exporte un payout vers SFTP
 *
 * @param {string} payoutId - ID du payout à exporter
 * @param {Object} options - Options d'export
 * @param {boolean} options.force - Forcer l'export même si déjà exporté
 * @param {boolean} options.testMode - Sauvegarder localement au lieu d'envoyer SFTP
 * @returns {Promise<Object>} Résultat de l'export
 */
async function exportPayout(payoutId, options = {}) {
  const { force = false, testMode = config.test.testMode } = options;

  log.info('Export du payout', { payoutId, force, testMode });

  // Vérifier si déjà exporté
  if (!force && isPayoutExported(payoutId)) {
    log.info('Payout déjà exporté', { payoutId });
    return {
      success: true,
      skipped: true,
      reason: 'already_exported',
      payoutId,
    };
  }

  try {
    // 1. Récupérer les détails du payout
    const payout = await shopifyService.getPayoutById(payoutId);

    if (!payout) {
      return {
        success: false,
        error: `Payout non trouvé: ${payoutId}`,
      };
    }

    // 2. Récupérer les transactions du payout
    const rawTransactions = await shopifyService.getPayoutTransactions(payoutId);

    // 3. Enrichir les transactions avec les noms de commandes
    const transactions = await enrichTransactionsWithOrderNames(rawTransactions);

    // 4. Générer le contenu du fichier
    const fileContent = generateTransactionFileContent(payout, transactions);
    const fileName = generateFileName(payout);

    // 4. Envoyer le fichier
    let result;

    if (testMode) {
      result = await saveFileLocally(fileContent, fileName);
    } else {
      result = await sftpService.uploadFile(
        fileContent,
        fileName,
        config.sftp.remoteDirTransactions
      );
    }

    // 5. Marquer comme exporté
    if (!testMode) {
      await markPayoutAsExported(payoutId);
    }

    log.info('Payout exporté avec succès', {
      payoutId,
      fileName,
      testMode,
    });

    return {
      success: true,
      payoutId,
      fileName,
      testMode,
      transactionCount: transactions.filter((t) => t.type === 'charge').length,
      payout: {
        date: payout.date,
        amount: payout.amount,
        status: payout.status,
      },
      ...result,
    };
  } catch (error) {
    log.error('Erreur lors de l\'export du payout', {
      payoutId,
      error: error.message,
    });

    return {
      success: false,
      payoutId,
      error: error.message,
    };
  }
}

/**
 * Sauvegarde un fichier localement (mode test)
 *
 * @param {string} content - Contenu du fichier
 * @param {string} fileName - Nom du fichier
 * @returns {Promise<Object>} Résultat
 */
async function saveFileLocally(content, fileName) {
  const localDir = path.resolve(config.test.localDownloadDir, 'transactions');

  try {
    await fs.mkdir(localDir, { recursive: true });

    const localPath = path.join(localDir, fileName);
    await fs.writeFile(localPath, content, 'utf-8');

    log.info('Fichier transaction sauvegardé localement', { localPath });

    return {
      localPath,
      size: content.length,
    };
  } catch (error) {
    log.error('Erreur sauvegarde locale', { error: error.message });
    throw error;
  }
}

/**
 * Exporte tous les payouts payés non encore exportés
 *
 * @param {Object} options - Options
 * @param {number} options.limit - Nombre de payouts à vérifier
 * @param {boolean} options.testMode - Mode test (sauvegarde locale)
 * @returns {Promise<Object>} Résumé des exports
 */
async function exportAllPendingPayouts(options = {}) {
  const { limit = 20, testMode = config.test.testMode } = options;

  log.info('Export de tous les payouts en attente', { limit, testMode });

  const results = {
    success: true,
    exported: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  try {
    // Récupérer les payouts payés
    const payouts = await shopifyService.getPaidPayouts(limit);

    log.info('Payouts payés trouvés', { count: payouts.length });

    for (const payout of payouts) {
      const exportResult = await exportPayout(payout.id, { testMode });

      results.details.push(exportResult);

      if (exportResult.skipped) {
        results.skipped++;
      } else if (exportResult.success) {
        results.exported++;
      } else {
        results.failed++;
      }
    }
  } catch (error) {
    log.error('Erreur lors de l\'export des payouts', { error: error.message });
    results.success = false;
    results.error = error.message;
  }

  log.info('Export des payouts terminé', {
    exported: results.exported,
    skipped: results.skipped,
    failed: results.failed,
  });

  return results;
}

/**
 * Prévisualise le fichier de transaction pour un payout
 * Sans l'envoyer sur SFTP
 *
 * @param {string} payoutId - ID du payout
 * @returns {Promise<Object>} Aperçu du fichier
 */
async function previewPayoutFile(payoutId) {
  log.info('Prévisualisation du fichier de transaction', { payoutId });

  try {
    const payout = await shopifyService.getPayoutById(payoutId);

    if (!payout) {
      return {
        success: false,
        error: `Payout non trouvé: ${payoutId}`,
      };
    }

    // Récupérer et enrichir les transactions avec les noms de commandes
    const rawTransactions = await shopifyService.getPayoutTransactions(payoutId);
    const transactions = await enrichTransactionsWithOrderNames(rawTransactions);

    const fileContent = generateTransactionFileContent(payout, transactions);
    const fileName = generateFileName(payout);

    return {
      success: true,
      payoutId,
      fileName,
      isAlreadyExported: isPayoutExported(payoutId),
      payout: {
        id: payout.id,
        bank_reference: payout.bank_reference || null,
        date: payout.date,
        amount: payout.amount,
        currency: payout.currency,
        status: payout.status,
      },
      transactionCount: transactions.filter((t) => t.type === 'charge').length,
      fileContent,
      fileSize: fileContent.length,
    };
  } catch (error) {
    log.error('Erreur lors de la prévisualisation', {
      payoutId,
      error: error.message,
    });

    return {
      success: false,
      payoutId,
      error: error.message,
    };
  }
}

/**
 * Liste les payouts disponibles avec leur statut d'export
 *
 * @param {number} limit - Nombre de payouts à lister
 * @returns {Promise<Object>} Liste des payouts
 */
async function listPayouts(limit = 20) {
  log.info('Liste des payouts', { limit });

  try {
    const payouts = await shopifyService.getPaidPayouts(limit);

    const payoutsWithStatus = payouts.map((p) => ({
      id: p.id,
      date: p.date,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      isExported: isPayoutExported(p.id),
    }));

    return {
      success: true,
      count: payoutsWithStatus.length,
      payouts: payoutsWithStatus,
    };
  } catch (error) {
    log.error('Erreur lors de la liste des payouts', { error: error.message });

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Réinitialise la liste des payouts exportés
 * Utile pour forcer un ré-export
 */
async function resetExportedPayouts() {
  exportedPayouts.clear();
  await saveExportedPayouts();
  log.info('Liste des payouts exportés réinitialisée');
}

// Charger les payouts exportés au démarrage
loadExportedPayouts();

module.exports = {
  exportPayout,
  exportAllPendingPayouts,
  previewPayoutFile,
  listPayouts,
  generateTransactionFileContent,
  generateFileName,
  isPayoutExported,
  markPayoutAsExported,
  resetExportedPayouts,
  loadExportedPayouts,
};
