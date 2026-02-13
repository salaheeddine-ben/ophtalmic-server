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
 * Format du fichier selon les specs client Ophtalmic :
 * - Section ENTETE avec les informations essentielles (SANS remise globale)
 * - Section LIGNES avec le détail des articles
 *
 * IMPORTANT: Toujours mettre 0 pour les champs vides (ne pas laisser vide)
 *
 * @param {Object} order - Commande Shopify (données du webhook)
 * @returns {string} Contenu formaté du fichier TXT
 */
function generateOrderFileContent(order) {
  log.info('Génération du contenu du fichier de commande', {
    orderName: order.name,
    orderId: order.id,
  });

  // Extraction des données de livraison et facturation
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || shipping;

  // Calcul des frais de port (mettre 0 si pas de frais)
  const shippingPrice = parseFloat(order.shipping_lines?.[0]?.price) || 0;

  // Récupérer l'identifiant de transaction de paiement
  const transactionId = order.checkout_token
    || order.payment_gateway_names?.[0]
    || order.id?.toString()
    || '0';

  // Formater la date au format AAAA-MM-JJ
  const orderDate = new Date(order.created_at).toISOString().split('T')[0];

  // Vérifier si l'adresse de facturation est différente de la livraison
  const isBillingDifferent =
    billing.address1 !== shipping.address1 ||
    billing.city !== shipping.city ||
    billing.zip !== shipping.zip;

  // Récupérer le téléphone (obligatoire selon le client - mettre 0 si absent)
  const phoneNumber = shipping.phone || billing.phone || order.phone || '0';

  // ============================================
  // Calculer le montant TTC correctement
  // TTC = somme des (prix unitaire TTC * quantité - remise) + frais de port
  // ============================================
  let calculatedTTC = 0;
  let calculatedTVA = 0;
  const taxRate = 0.20;

  for (const item of order.line_items || []) {
    const priceTTC = parseFloat(item.price) || 0;
    const quantity = parseInt(item.quantity) || 1;
    const lineDiscount = parseFloat(item.total_discount) || 0;

    // Total ligne TTC après remise
    const lineTotalTTC = (priceTTC * quantity) - lineDiscount;
    calculatedTTC += lineTotalTTC;

    // TVA sur cette ligne (TVA = TTC - HT, où HT = TTC / 1.20)
    const lineTotalHT = lineTotalTTC / (1 + taxRate);
    calculatedTVA += (lineTotalTTC - lineTotalHT);
  }

  // Ajouter les frais de port au TTC
  calculatedTTC += shippingPrice;

  // TVA sur les frais de port (si applicable)
  const shippingHT = shippingPrice / (1 + taxRate);
  calculatedTVA += (shippingPrice - shippingHT);

  // Formater les montants avec 2 décimales
  const totalTTC = calculatedTTC.toFixed(2);
  const totalTVA = calculatedTVA.toFixed(2);

  log.debug('Calcul TTC', {
    calculatedTTC: totalTTC,
    calculatedTVA: totalTVA,
    shippingPrice: shippingPrice.toFixed(2),
    shopifyTotalPrice: order.total_price,
    shopifyTotalTax: order.total_tax,
  });

  // ============================================
  // Construire la section ENTETE (selon specs client)
  // NOTE: PAS de remise globale dans l'entête
  // ============================================
  const headerLines = [
    'ENTETE',
    order.name || order.order_number || '0',
    '0147907400',
    orderDate,
    order.email || '0',
    phoneNumber,
    shipping.last_name || '0',
    shipping.first_name || '0',
    shipping.address1 || '0',
    shipping.zip || '0',
    shipping.city || '0',
    shipping.country_code || 'FR',
    shippingPrice.toFixed(2),
    totalTTC,
    totalTVA,
    transactionId,
  ];

  // Ajouter l'adresse de facturation seulement si différente
  if (isBillingDifferent) {
    headerLines.push(
      billing.last_name || '0',
      billing.first_name || '0',
      billing.address1 || '0',
      billing.zip || '0',
      billing.city || '0',
      billing.country_code || 'FR'
    );
  }

  // ============================================
  // Construire la section LIGNES (selon specs client)
  // Avec: SKU, Désignation, Qté, Prix Unitaire HT, Remise par ligne (%)
  // IMPORTANT: Toujours mettre 0 si pas de valeur
  // ============================================
  const itemLines = ['LIGNES'];

  // Parcourir les articles de la commande
  for (const item of order.line_items || []) {
    // Prix TTC unitaire
    const priceTTC = parseFloat(item.price) || 0;

    // Calculer le prix HT (TVA à 20%)
    const priceHT = (priceTTC / (1 + taxRate)).toFixed(2);

    // Remise par ligne en pourcentage
    const lineDiscount = parseFloat(item.total_discount) || 0;
    const quantity = parseInt(item.quantity) || 1;
    const lineTotal = priceTTC * quantity;

    // Calculer le pourcentage de remise (0 si pas de remise)
    const discountPercentage = lineTotal > 0 && lineDiscount > 0
      ? ((lineDiscount / lineTotal) * 100).toFixed(2)
      : '0';

    const itemLine = [
      item.sku || item.variant_id || '0',
      sanitizeText(item.title || item.name || '0'),
      quantity,
      priceHT,
      discountPercentage,
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
 * @param {string} scenario - Type de scénario: 'with_discount', 'no_discount', 'multiple_items', 'minimal'
 * @returns {Promise<Object>} Résultat de l'export
 */
async function generateTestOrderFile(scenario = 'with_discount') {
  log.info('Génération d\'un fichier de commande de test', { scenario });

  // Données de base pour tous les scénarios
  const baseOrder = {
    id: 5123456789,
    created_at: new Date().toISOString(),
    currency: 'EUR',
    checkout_token: 'test_checkout_' + uuidv4().substring(0, 8),
    payment_gateway_names: ['shopify_payments'],
    shipping_address: {
      first_name: 'Jean',
      last_name: 'Dupont',
      address1: '123 Rue de la République',
      city: 'Paris',
      zip: '75001',
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
    customer: {
      id: 9876543210,
      email: 'client.test@example.com',
      first_name: 'Jean',
      last_name: 'Dupont',
    },
  };

  let mockOrder;

  switch (scenario) {
    case 'no_discount':
      // Cas 1: Commande SANS remise
      mockOrder = {
        ...baseOrder,
        name: 'SH1-TEST-SANS-REMISE',
        order_number: 2001,
        email: 'client.test@example.com',
        total_price: '89.90',
        subtotal_price: '84.00',
        total_tax: '16.80',
        total_discounts: '0.00',
        shipping_lines: [{ title: 'Livraison Standard', price: '5.90' }],
        line_items: [
          {
            id: 12345,
            sku: 'LENS-DAILY-001',
            title: 'Lentilles journalières - Boîte de 30',
            quantity: 2,
            price: '42.00',
            total_discount: '0', // PAS de remise
            variant_id: 98765,
          },
        ],
      };
      break;

    case 'multiple_items':
      // Cas 2: Commande avec PLUSIEURS articles et remises variées
      mockOrder = {
        ...baseOrder,
        name: 'SH1-TEST-MULTI-ARTICLES',
        order_number: 2002,
        email: 'client.multi@example.com',
        total_price: '156.70',
        subtotal_price: '150.80',
        total_tax: '30.16',
        total_discounts: '15.00',
        shipping_lines: [{ title: 'Livraison Express', price: '9.90' }],
        line_items: [
          {
            id: 12345,
            sku: 'HYDRO-LARMES-001',
            title: 'Hydrofeel Larmes Artificielles - 10ml',
            quantity: 2,
            price: '29.90',
            total_discount: '10.00', // Remise de 10€
            variant_id: 98765,
          },
          {
            id: 12346,
            sku: 'LENS-CLEAN-002',
            title: 'Solution Nettoyante Lentilles - 360ml',
            quantity: 1,
            price: '24.10',
            total_discount: '0', // PAS de remise
            variant_id: 98766,
          },
          {
            id: 12347,
            sku: 'LENS-MONTHLY-003',
            title: 'Lentilles mensuelles - Pack 6 mois',
            quantity: 1,
            price: '89.90',
            total_discount: '5.00', // Remise de 5€
            variant_id: 98767,
          },
        ],
      };
      break;

    case 'minimal':
      // Cas 3: Commande minimale (1 article, pas de remise, valeurs minimales)
      mockOrder = {
        ...baseOrder,
        name: 'SH1-TEST-MINIMAL',
        order_number: 2003,
        email: 'minimal@example.com',
        total_price: '19.90',
        subtotal_price: '14.00',
        total_tax: '2.80',
        total_discounts: '0.00',
        shipping_lines: [{ title: 'Livraison Standard', price: '5.90' }],
        line_items: [
          {
            id: 12348,
            sku: 'SAMPLE-001',
            title: 'Échantillon produit',
            quantity: 1,
            price: '14.00',
            total_discount: '0',
            variant_id: 98768,
          },
        ],
      };
      break;

    case 'with_discount':
    default:
      // Cas par défaut: Commande AVEC remise
      mockOrder = {
        ...baseOrder,
        name: 'SH1-TEST-AVEC-REMISE',
        order_number: 2000,
        email: 'client.test@example.com',
        total_price: '89.90',
        subtotal_price: '74.92',
        total_tax: '14.98',
        total_discounts: '10.00',
        shipping_lines: [{ title: 'Livraison Standard', price: '5.90' }],
        line_items: [
          {
            id: 12345,
            sku: 'HYDRO-LARMES-001',
            title: 'Hydrofeel Larmes Artificielles - 10ml',
            quantity: 2,
            price: '29.90',
            total_discount: '5.00', // Remise de 5€ sur cette ligne
            variant_id: 98765,
          },
          {
            id: 12346,
            sku: 'LENS-CLEAN-002',
            title: 'Solution Nettoyante Lentilles - 360ml',
            quantity: 1,
            price: '24.10',
            total_discount: '5.00', // Remise de 5€ sur cette ligne
            variant_id: 98766,
          },
        ],
      };
      break;
  }

  // Forcer le mode test pour cette génération
  const originalTestMode = config.test.testMode;
  config.test.testMode = true;

  try {
    const result = await exportOrder(mockOrder);

    return {
      ...result,
      scenario,
      message: `Fichier de test généré avec succès (scénario: ${scenario})`,
      mockOrder: {
        name: mockOrder.name,
        itemCount: mockOrder.line_items.length,
        totalPrice: mockOrder.total_price,
        totalDiscounts: mockOrder.total_discounts,
      },
    };
  } finally {
    // Restaurer le mode original
    config.test.testMode = originalTestMode;
  }
}

/**
 * Génère TOUS les cas de test d'un coup
 * Utile pour fournir plusieurs exemples au client
 *
 * @returns {Promise<Object>} Résultats de tous les exports
 */
async function generateAllTestCases() {
  log.info('Génération de tous les cas de test');

  const scenarios = ['with_discount', 'no_discount', 'multiple_items', 'minimal'];
  const results = [];

  for (const scenario of scenarios) {
    try {
      const result = await generateTestOrderFile(scenario);
      results.push(result);
    } catch (error) {
      log.error('Erreur lors de la génération du cas de test', {
        scenario,
        error: error.message,
      });
      results.push({
        scenario,
        success: false,
        error: error.message,
      });
    }
  }

  return {
    success: true,
    totalGenerated: results.filter((r) => r.success).length,
    totalFailed: results.filter((r) => !r.success).length,
    results,
  };
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
  generateAllTestCases,
  readLocalOrderFile,
  listLocalOrderFiles,
  saveFileLocally,
  sanitizeText,
};
