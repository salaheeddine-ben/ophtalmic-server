/**
 * Routes de test - Endpoints pour tester les différents services
 *
 * Ces routes permettent de tester individuellement chaque composant
 * de l'application sans avoir à attendre les événements réels.
 *
 * ATTENTION: Ces routes sont destinées au développement et aux tests.
 * En production, il est recommandé de les protéger ou de les désactiver.
 *
 * @module routes/testRoutes
 */

const express = require('express');
const asyncHandler = require('express-async-handler');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');
const sageX3Service = require('../services/sageX3Service');
const shopifyService = require('../services/shopifyService');
const sftpService = require('../services/sftpService');
const orderExportService = require('../services/orderExportService');

// Logger
const log = logger;

// Créer le router Express
const router = express.Router();

/**
 * GET /test/stock
 *
 * Teste l'appel au webservice SOAP Sage X3 pour récupérer le stock.
 * Affiche la réponse sans mettre à jour Shopify.
 *
 * @route GET /test/stock
 * @param {string} [query.ean] - Code EAN du produit (optionnel, utilise config par défaut)
 * @returns {Object} Données de stock retournées par Sage X3
 */
router.get(
  '/stock',
  asyncHandler(async (req, res) => {
    const eanCode = req.query.ean || config.product.hydrofellEan;

    log.info('Test de récupération du stock Sage X3', { eanCode });

    try {
      const stockData = await sageX3Service.getProductStock(eanCode);

      res.json({
        success: true,
        message: 'Stock récupéré avec succès depuis Sage X3',
        eanCode,
        stockData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors du test de stock', { error: error.message });

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération du stock',
        error: error.message,
        eanCode,
      });
    }
  })
);

/**
 * GET /test/sage-connection
 *
 * Teste la connexion au webservice SOAP Sage X3.
 * Vérifie que le WSDL est accessible et liste les méthodes disponibles.
 *
 * @route GET /test/sage-connection
 */
router.get(
  '/sage-connection',
  asyncHandler(async (req, res) => {
    log.info('Test de connexion à Sage X3');

    const result = await sageX3Service.testConnection();

    res.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /test/sftp
 *
 * Teste la connexion SFTP et liste les fichiers du dossier de destination.
 *
 * @route GET /test/sftp
 * @param {string} [query.dir] - Dossier à lister (optionnel)
 */
router.get(
  '/sftp',
  asyncHandler(async (req, res) => {
    const remoteDir = req.query.dir || config.sftp.remoteDir;

    log.info('Test de connexion SFTP', { remoteDir });

    try {
      // Tester la connexion
      const connectionTest = await sftpService.testConnection();

      if (!connectionTest.success) {
        return res.status(500).json(connectionTest);
      }

      // Lister les fichiers
      const files = await sftpService.listFiles(remoteDir);

      res.json({
        success: true,
        message: 'Connexion SFTP réussie',
        connection: connectionTest,
        files: {
          directory: remoteDir,
          count: files.length,
          items: files,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors du test SFTP', { error: error.message });

      res.status(500).json({
        success: false,
        message: 'Erreur de connexion SFTP',
        error: error.message,
      });
    }
  })
);

/**
 * POST /test/generate-order-file
 *
 * Génère un fichier TXT de test avec des données de commande mockées.
 * Le fichier est sauvegardé localement (mode test forcé).
 *
 * @route POST /test/generate-order-file
 * @returns {Object} Informations sur le fichier généré
 */
router.post(
  '/generate-order-file',
  asyncHandler(async (req, res) => {
    log.info('Génération d\'un fichier de commande de test');

    try {
      const result = await orderExportService.generateTestOrderFile();

      res.json({
        success: true,
        message: 'Fichier de test généré avec succès',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la génération du fichier test', {
        error: error.message,
      });

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la génération du fichier',
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/local-files
 *
 * Liste les fichiers de commande générés localement (mode test).
 *
 * @route GET /test/local-files
 */
router.get(
  '/local-files',
  asyncHandler(async (req, res) => {
    log.info('Liste des fichiers de commande locaux');

    try {
      const files = await orderExportService.listLocalOrderFiles();

      res.json({
        success: true,
        localDirectory: config.test.localDownloadDir,
        fileCount: files.length,
        files,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la liste des fichiers locaux', {
        error: error.message,
      });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/local-file/:filename
 *
 * Lit et affiche le contenu d'un fichier de commande local.
 *
 * @route GET /test/local-file/:filename
 * @param {string} filename - Nom du fichier à lire
 */
router.get(
  '/local-file/:filename',
  asyncHandler(async (req, res) => {
    const { filename } = req.params;

    log.info('Lecture du fichier local', { filename });

    try {
      const content = await orderExportService.readLocalOrderFile(filename);

      // Option pour télécharger le fichier ou l'afficher
      if (req.query.download === 'true') {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(content);
      }

      res.json({
        success: true,
        filename,
        content,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la lecture du fichier', {
        filename,
        error: error.message,
      });

      res.status(404).json({
        success: false,
        message: 'Fichier non trouvé',
        filename,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/shopify-connection
 *
 * Teste la connexion à l'API Shopify.
 *
 * @route GET /test/shopify-connection
 */
router.get(
  '/shopify-connection',
  asyncHandler(async (req, res) => {
    log.info('Test de connexion à Shopify');

    const result = await shopifyService.testConnection();

    res.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /test/shopify-config
 *
 * Récupère les informations de configuration Shopify.
 * Utile pour trouver les IDs de location et d'inventaire.
 *
 * @route GET /test/shopify-config
 */
router.get(
  '/shopify-config',
  asyncHandler(async (req, res) => {
    log.info('Récupération de la configuration Shopify');

    try {
      const result = await shopifyService.getConfigurationInfo();

      res.json({
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la récupération de la config Shopify', {
        error: error.message,
      });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/shopify-product/:sku
 *
 * Recherche un produit Shopify par son SKU ou code-barres.
 *
 * @route GET /test/shopify-product/:sku
 * @param {string} sku - SKU ou code-barres du produit
 */
router.get(
  '/shopify-product/:sku',
  asyncHandler(async (req, res) => {
    const { sku } = req.params;

    log.info('Recherche de produit Shopify', { sku });

    try {
      const result = await shopifyService.findProductBySku(sku);

      if (!result) {
        return res.status(404).json({
          success: false,
          message: 'Produit non trouvé',
          sku,
        });
      }

      res.json({
        success: true,
        sku,
        product: {
          id: result.product.id,
          title: result.product.title,
        },
        variant: {
          id: result.variant.id,
          sku: result.variant.sku,
          barcode: result.variant.barcode,
          inventoryItemId: result.inventoryItemId,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la recherche de produit', {
        sku,
        error: error.message,
      });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * POST /test/sync-stock
 *
 * Lance manuellement une synchronisation du stock.
 * Récupère le stock depuis Sage X3 et met à jour Shopify.
 *
 * @route POST /test/sync-stock
 * @param {string} [query.ean] - Code EAN du produit
 * @param {boolean} [query.dryRun] - Si true, ne met pas à jour Shopify
 */
router.post(
  '/sync-stock',
  asyncHandler(async (req, res) => {
    const eanCode = req.query.ean || config.product.hydrofellEan;
    const dryRun = req.query.dryRun === 'true';

    log.info('Synchronisation manuelle du stock', { eanCode, dryRun });

    try {
      // 1. Récupérer le stock depuis Sage X3
      const stockData = await sageX3Service.getProductStock(eanCode);

      if (dryRun) {
        return res.json({
          success: true,
          message: 'Dry run - Aucune mise à jour effectuée sur Shopify',
          dryRun: true,
          stockData,
          timestamp: new Date().toISOString(),
        });
      }

      // 2. Mettre à jour sur Shopify
      const updateResult = await shopifyService.updateInventoryLevel(stockData.quantity);

      res.json({
        success: true,
        message: 'Stock synchronisé avec succès',
        sageX3Stock: stockData,
        shopifyUpdate: updateResult,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la synchronisation du stock', {
        eanCode,
        error: error.message,
      });

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la synchronisation',
        error: error.message,
      });
    }
  })
);

/**
 * POST /test/upload-sftp
 *
 * Teste l'upload d'un fichier sur SFTP.
 *
 * @route POST /test/upload-sftp
 * @param {string} req.body.content - Contenu du fichier
 * @param {string} req.body.filename - Nom du fichier
 */
router.post(
  '/upload-sftp',
  asyncHandler(async (req, res) => {
    const { content, filename } = req.body;

    if (!content || !filename) {
      return res.status(400).json({
        success: false,
        message: 'content et filename sont requis',
      });
    }

    log.info('Test d\'upload SFTP', { filename });

    try {
      const result = await sftpService.uploadFile(content, filename);

      res.json({
        success: true,
        message: 'Fichier uploadé avec succès',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de l\'upload SFTP', {
        filename,
        error: error.message,
      });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/config
 *
 * Affiche la configuration actuelle (sans les secrets).
 * Utile pour vérifier que l'environnement est bien configuré.
 *
 * @route GET /test/config
 */
router.get('/config', (req, res) => {
  res.json({
    server: {
      port: config.server.port,
      nodeEnv: config.server.nodeEnv,
      isProduction: config.server.isProduction,
    },
    shopify: {
      storeUrl: config.shopify.storeUrl,
      configured: !!config.shopify.accessToken,
      inventoryItemId: config.shopify.inventoryItemId || 'NON CONFIGURÉ',
      locationId: config.shopify.locationId || 'NON CONFIGURÉ',
      apiVersion: config.shopify.apiVersion,
    },
    sageX3: {
      wsdlUrl: config.sageX3.wsdlUrl,
      user: config.sageX3.user,
      poolAlias: config.sageX3.poolAlias,
      site: config.sageX3.site,
      publicName: config.sageX3.publicName,
    },
    sftp: {
      host: config.sftp.host,
      port: config.sftp.port,
      user: config.sftp.user,
      remoteDir: config.sftp.remoteDir,
    },
    test: {
      testMode: config.test.testMode,
      localDownloadDir: config.test.localDownloadDir,
    },
    product: {
      hydrofellEan: config.product.hydrofellEan,
    },
    stockSync: {
      enabled: config.stockSync.enabled,
      cronExpression: config.stockSync.cronExpression,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /test/health
 *
 * Vérification de santé des routes de test.
 *
 * @route GET /test/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Routes de test opérationnelles',
    testMode: config.test.testMode,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
