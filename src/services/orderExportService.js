/**
 * Service d'export des commandes - Génération des fichiers TXT pour Sage X3
 *
 * Ce service gère la transformation des commandes Shopify en fichiers
 * texte formatés pour l'import dans Sage X3 via SFTP.
 *
 * Le format du fichier est défini selon les spécifications du client :
 * - Section ENTETE avec les informations client et commande
 * - Section LIGNES avec le détail des articles commandés
 *
 * @module services/orderExportService
 */

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');
const sftpService = require('./sftpService');

// Logger dédié à ce module
const log = createModuleLogger('orderExportService');

/**
 * Génère le contenu du fichier TXT à partir d'une commande Shopify
 *
 * Format du fichier :
 * ```
 * ENTETE
 * REF_COMMANDE|[order.name]
 * REF_CLIENT|[code_client]
 * NOM|[shipping_address.last_name]
 * ...
 * LIGNES
 * SKU|DESIGNATION|QTE|PRIX_UNITAIRE_HT|PRIX_UNITAIRE_TTC
 * [sku]|[title]|[quantity]|[price]|[price]
 * ```
 *
 * @param {Object} order - Commande Shopify (données du webhook)
 * @returns {string} Contenu formaté du fichier TXT
 */
function generateOrderFileContent(order) {
  log.info('Génération du contenu du fichier de commande', {
    orderName: order.name,
    orderId: order.id,
  });

  // Extraction des données de livraison
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || shipping;

  // Calcul des frais de port
  const shippingPrice = order.shipping_lines?.[0]?.price || '0.00';

  // Récupérer l'identifiant de transaction de paiement
  // Peut être dans checkout_token, payment_gateway_names, ou transactions
  const transactionId = order.checkout_token
    || order.payment_gateway_names?.[0]
    || order.id?.toString()
    || '';

  // Formater la date au format AAAA-MM-JJ
  const orderDate = new Date(order.created_at).toISOString().split('T')[0];

  // ============================================
  // Construire la section ENTETE
  // ============================================
  const headerLines = [
    'ENTETE',
    `REF_COMMANDE|${order.name || order.order_number}`,
    `DATE_COMMANDE|${orderDate}`,
    // TODO: Le code client est à confirmer avec le client
    // Il peut s'agir d'un code fixe ou d'un mapping depuis l'email/téléphone
    `REF_CLIENT|${order.customer?.id || '0147907400'}`,
    `EMAIL_CLIENT|${order.email || ''}`,
    `TELEPHONE|${shipping.phone || billing.phone || ''}`,
    `NOM|${shipping.last_name || ''}`,
    `PRENOM|${shipping.first_name || ''}`,
    `SOCIETE|${shipping.company || ''}`,
    `ADRESSE|${shipping.address1 || ''}`,
    `ADRESSE2|${shipping.address2 || ''}`,
    `CP|${shipping.zip || ''}`,
    `VILLE|${shipping.city || ''}`,
    `PROVINCE|${shipping.province || ''}`,
    `PAYS|${shipping.country_code || 'FR'}`,
    `FRAIS_PORT|${shippingPrice}`,
    `MONTANT_HT|${order.subtotal_price || '0.00'}`,
    `MONTANT_TAXES|${order.total_tax || '0.00'}`,
    `MONTANT_TTC|${order.total_price || '0.00'}`,
    `DEVISE|${order.currency || 'EUR'}`,
    `MODE_PAIEMENT|${order.payment_gateway_names?.join(',') || 'CB'}`,
    `TRANSACTION_CB|${transactionId}`,
    // Informations de facturation (si différentes de livraison)
    `FACT_NOM|${billing.last_name || shipping.last_name || ''}`,
    `FACT_PRENOM|${billing.first_name || shipping.first_name || ''}`,
    `FACT_ADRESSE|${billing.address1 || shipping.address1 || ''}`,
    `FACT_CP|${billing.zip || shipping.zip || ''}`,
    `FACT_VILLE|${billing.city || shipping.city || ''}`,
    `FACT_PAYS|${billing.country_code || shipping.country_code || 'FR'}`,
    // Notes et commentaires
    `NOTE_CLIENT|${sanitizeText(order.note || '')}`,
  ];

  // ============================================
  // Construire la section LIGNES
  // ============================================
  const itemLines = ['LIGNES', 'SKU|DESIGNATION|QTE|PRIX_UNITAIRE_HT|PRIX_UNITAIRE_TTC|REMISE'];

  // Parcourir les articles de la commande
  for (const item of order.line_items || []) {
    // Calculer le prix HT si nécessaire (Shopify fournit généralement le TTC)
    // Note: Le taux de TVA dépend du produit, ici on utilise 20% par défaut
    const priceTTC = parseFloat(item.price) || 0;
    const taxRate = 0.20; // TODO: À adapter selon le type de produit
    const priceHT = (priceTTC / (1 + taxRate)).toFixed(2);

    // Calculer la remise totale sur la ligne
    const discount = item.total_discount || '0.00';

    // Construire la ligne article
    const itemLine = [
      item.sku || item.variant_id || '',
      sanitizeText(item.title || item.name || ''),
      item.quantity || 1,
      priceHT,
      priceTTC.toFixed(2),
      discount,
    ].join('|');

    itemLines.push(itemLine);
  }

  // ============================================
  // Assembler le fichier complet
  // ============================================
  const fileContent = [...headerLines, '', ...itemLines].join('\n');

  log.debug('Contenu du fichier généré', {
    orderName: order.name,
    lineCount: headerLines.length + itemLines.length,
    contentLength: fileContent.length,
  });

  return fileContent;
}

/**
 * Nettoie le texte pour éviter les problèmes de formatage
 * - Supprime les retours à la ligne
 * - Remplace les pipes par des tirets (séparateur du format)
 *
 * @param {string} text - Texte à nettoyer
 * @returns {string} Texte nettoyé
 */
function sanitizeText(text) {
  if (!text) return '';
  return text
    .replace(/\r?\n/g, ' ') // Remplacer les retours à la ligne par des espaces
    .replace(/\|/g, '-') // Remplacer les pipes (séparateur)
    .replace(/\s+/g, ' ') // Réduire les espaces multiples
    .trim();
}

/**
 * Génère le nom du fichier pour une commande
 *
 * Format: COMMANDE_[REF]_[TIMESTAMP].txt
 * Exemple: COMMANDE_1234_20231215_143022.txt
 *
 * @param {Object} order - Commande Shopify
 * @returns {string} Nom du fichier
 */
function generateFileName(order) {
  const orderRef = order.name || order.order_number || order.id;
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .split('.')[0];

  return `COMMANDE_${orderRef}_${timestamp}.txt`;
}

/**
 * Exporte une commande vers un fichier
 *
 * En mode test (TEST_MODE=true) :
 * - Le fichier est sauvegardé localement dans LOCAL_DOWNLOAD_DIR
 *
 * En mode production :
 * - Le fichier est envoyé sur le serveur SFTP
 *
 * @param {Object} order - Commande Shopify (données du webhook)
 * @returns {Promise<Object>} Résultat de l'export { success, filePath, ... }
 */
async function exportOrder(order) {
  log.info('Export de la commande', {
    orderName: order.name,
    orderId: order.id,
    testMode: config.test.testMode,
  });

  try {
    // Générer le contenu et le nom du fichier
    const fileContent = generateOrderFileContent(order);
    const fileName = generateFileName(order);

    let result;

    if (config.test.testMode) {
      // Mode test : sauvegarder localement
      result = await saveFileLocally(fileContent, fileName);
    } else {
      // Mode production : envoyer sur SFTP
      result = await sftpService.uploadFile(fileContent, fileName);
    }

    log.info('Commande exportée avec succès', {
      orderName: order.name,
      fileName,
      testMode: config.test.testMode,
      ...result,
    });

    return {
      success: true,
      orderName: order.name,
      orderId: order.id,
      fileName,
      testMode: config.test.testMode,
      ...result,
    };
  } catch (error) {
    log.error('Erreur lors de l\'export de la commande', {
      orderName: order.name,
      orderId: order.id,
      error: error.message,
    });

    throw error;
  }
}

/**
 * Sauvegarde un fichier localement (mode test)
 *
 * @param {string} content - Contenu du fichier
 * @param {string} fileName - Nom du fichier
 * @returns {Promise<Object>} Résultat { localPath }
 */
async function saveFileLocally(content, fileName) {
  // S'assurer que le dossier de destination existe
  const localDir = path.resolve(config.test.localDownloadDir);

  log.debug('Sauvegarde locale du fichier', {
    localDir,
    fileName,
  });

  try {
    // Créer le dossier s'il n'existe pas
    await fs.mkdir(localDir, { recursive: true });

    // Chemin complet du fichier
    const localPath = path.join(localDir, fileName);

    // Écrire le fichier
    await fs.writeFile(localPath, content, 'utf-8');

    log.info('Fichier sauvegardé localement', {
      localPath,
      size: content.length,
    });

    return {
      localPath,
      size: content.length,
      message: `Fichier sauvegardé localement: ${localPath}`,
    };
  } catch (error) {
    log.error('Erreur lors de la sauvegarde locale', {
      error: error.message,
      localDir,
      fileName,
    });
    throw error;
  }
}

/**
 * Génère un fichier de test avec des données mockées
 * Utile pour tester le format sans vraie commande
 *
 * @returns {Promise<Object>} Résultat de l'export
 */
async function generateTestOrderFile() {
  log.info('Génération d\'un fichier de commande de test');

  // Données mockées ressemblant à une vraie commande Shopify
  const mockOrder = {
    id: 5123456789,
    name: '#TEST-001',
    order_number: 1001,
    email: 'client.test@example.com',
    created_at: new Date().toISOString(),
    currency: 'EUR',
    total_price: '89.90',
    subtotal_price: '74.92',
    total_tax: '14.98',
    checkout_token: 'test_checkout_' + uuidv4().substring(0, 8),
    payment_gateway_names: ['shopify_payments'],
    note: 'Commande de test générée automatiquement',

    shipping_address: {
      first_name: 'Jean',
      last_name: 'Dupont',
      company: 'Ophtalmic SARL',
      address1: '123 Rue de la République',
      address2: 'Bâtiment A',
      city: 'Paris',
      zip: '75001',
      province: 'Île-de-France',
      country_code: 'FR',
      phone: '+33 1 23 45 67 89',
    },

    billing_address: {
      first_name: 'Jean',
      last_name: 'Dupont',
      address1: '123 Rue de la République',
      city: 'Paris',
      zip: '75001',
      country_code: 'FR',
    },

    shipping_lines: [
      {
        title: 'Livraison Standard',
        price: '5.90',
      },
    ],

    line_items: [
      {
        id: 12345,
        sku: 'HYDRO-LARMES-001',
        title: 'Hydrofeel Larmes Artificielles - 10ml',
        quantity: 2,
        price: '29.90',
        total_discount: '0.00',
        variant_id: 98765,
      },
      {
        id: 12346,
        sku: 'LENS-CLEAN-002',
        title: 'Solution Nettoyante Lentilles - 360ml',
        quantity: 1,
        price: '24.10',
        total_discount: '5.00',
        variant_id: 98766,
      },
    ],

    customer: {
      id: 9876543210,
      email: 'client.test@example.com',
      first_name: 'Jean',
      last_name: 'Dupont',
    },
  };

  // Forcer le mode test pour cette génération
  const originalTestMode = config.test.testMode;
  config.test.testMode = true;

  try {
    const result = await exportOrder(mockOrder);

    return {
      ...result,
      message: 'Fichier de test généré avec succès',
      mockOrder: {
        name: mockOrder.name,
        itemCount: mockOrder.line_items.length,
        totalPrice: mockOrder.total_price,
      },
    };
  } finally {
    // Restaurer le mode original
    config.test.testMode = originalTestMode;
  }
}

/**
 * Lit un fichier de commande local (pour vérification)
 *
 * @param {string} fileName - Nom du fichier à lire
 * @returns {Promise<string>} Contenu du fichier
 */
async function readLocalOrderFile(fileName) {
  const localPath = path.join(path.resolve(config.test.localDownloadDir), fileName);

  log.debug('Lecture du fichier local', { localPath });

  try {
    const content = await fs.readFile(localPath, 'utf-8');
    return content;
  } catch (error) {
    log.error('Erreur lors de la lecture du fichier local', {
      error: error.message,
      localPath,
    });
    throw error;
  }
}

/**
 * Liste les fichiers de commande locaux
 *
 * @returns {Promise<Array>} Liste des fichiers
 */
async function listLocalOrderFiles() {
  const localDir = path.resolve(config.test.localDownloadDir);

  log.debug('Liste des fichiers locaux', { localDir });

  try {
    // Créer le dossier s'il n'existe pas
    await fs.mkdir(localDir, { recursive: true });

    const files = await fs.readdir(localDir);

    // Filtrer pour ne garder que les fichiers .txt
    const txtFiles = files.filter((f) => f.endsWith('.txt'));

    // Récupérer les stats de chaque fichier
    const fileInfos = await Promise.all(
      txtFiles.map(async (fileName) => {
        const filePath = path.join(localDir, fileName);
        const stats = await fs.stat(filePath);
        return {
          name: fileName,
          size: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime,
        };
      })
    );

    return fileInfos;
  } catch (error) {
    log.error('Erreur lors de la liste des fichiers locaux', {
      error: error.message,
      localDir,
    });
    throw error;
  }
}

module.exports = {
  exportOrder,
  generateOrderFileContent,
  generateFileName,
  generateTestOrderFile,
  readLocalOrderFile,
  listLocalOrderFiles,
  saveFileLocally,
  sanitizeText,
};
