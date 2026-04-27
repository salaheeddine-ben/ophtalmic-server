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
const webhookRoutes = require('./webhookRoutes');
const orderStatusSyncService = require('../services/orderStatusSyncService');
const statusSyncJob = require('../jobs/statusSyncJob');
const transactionExportService = require('../services/transactionExportService');
const transactionSyncJob = require('../jobs/transactionSyncJob');

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
 * @param {string} [query.scenario] - Scénario: 'with_discount', 'no_discount', 'multiple_items', 'minimal'
 * @returns {Object} Informations sur le fichier généré
 */
router.post(
  '/generate-order-file',
  asyncHandler(async (req, res) => {
    const scenario = req.query.scenario || 'with_discount';

    log.info('Génération d\'un fichier de commande de test', { scenario });

    try {
      const result = await orderExportService.generateTestOrderFile(scenario);

      res.json({
        success: true,
        message: 'Fichier de test généré avec succès',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la génération du fichier test', {
        error: error.message,
        scenario,
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
 * POST /test/generate-all-test-cases
 *
 * Génère TOUS les cas de test d'un coup (avec remise, sans remise, multi-articles, minimal).
 * Les fichiers sont sauvegardés localement (mode test forcé).
 *
 * @route POST /test/generate-all-test-cases
 * @returns {Object} Informations sur tous les fichiers générés
 */
router.post(
  '/generate-all-test-cases',
  asyncHandler(async (req, res) => {
    log.info('Génération de tous les cas de test');

    try {
      const result = await orderExportService.generateAllTestCases();

      res.json({
        success: true,
        message: 'Tous les cas de test ont été générés',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la génération des cas de test', {
        error: error.message,
      });

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la génération des fichiers',
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
 * GET /test/sftp-file/:filename
 *
 * Lit le contenu d'un fichier distant sur le serveur SFTP.
 *
 * @route GET /test/sftp-file/:filename
 * @param {string} filename - Nom du fichier à lire
 * @param {string} [query.download] - Si 'true', télécharge le fichier
 */
router.get(
  '/sftp-file/:filename',
  asyncHandler(async (req, res) => {
    const { filename } = req.params;
    const remoteDir = req.query.dir || config.sftp.remoteDir;

    log.info('Lecture fichier SFTP distant', { filename, remoteDir });

    try {
      const content = await sftpService.downloadFile(filename, remoteDir);

      if (req.query.download === 'true') {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(content);
      }

      res.json({
        success: true,
        filename,
        remotePath: `${remoteDir}${filename}`,
        content: content.toString('utf-8'),
        size: content.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lecture fichier SFTP', { filename, error: error.message });

      res.status(404).json({
        success: false,
        message: 'Fichier non trouvé sur le serveur SFTP',
        filename,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/sftp-browser
 *
 * Interface HTML pour naviguer et télécharger les fichiers SFTP.
 * Affiche une page web avec la liste des fichiers et des boutons de téléchargement.
 * Permet de naviguer entre les dossiers /in/ et /out/.
 *
 * @route GET /test/sftp-browser
 * @param {string} [query.dir] - Dossier à afficher: 'in', 'out', ou chemin complet
 */
router.get(
  '/sftp-browser',
  asyncHandler(async (req, res) => {
    // Déterminer le dossier à afficher
    let remoteDir = config.sftp.remoteDirIn; // Par défaut /in/
    let activeTab = 'in';

    if (req.query.dir === 'out') {
      remoteDir = config.sftp.remoteDirOut;
      activeTab = 'out';
    } else if (req.query.dir === 'in') {
      remoteDir = config.sftp.remoteDirIn;
      activeTab = 'in';
    } else if (req.query.dir === 'transactions') {
      remoteDir = config.sftp.remoteDirTransactions;
      activeTab = 'transactions';
    } else if (req.query.dir) {
      remoteDir = req.query.dir;
      activeTab = 'custom';
    }

    log.info('Affichage du navigateur SFTP', { remoteDir, activeTab });

    let files = [];
    let connectionError = null;

    try {
      // Tester la connexion et lister les fichiers
      const connectionTest = await sftpService.testConnection();

      if (connectionTest.success) {
        files = await sftpService.listFiles(remoteDir);
        // Trier par date de modification (plus récent en premier)
        files.sort((a, b) => new Date(b.modifyTime) - new Date(a.modifyTime));
      } else {
        connectionError = connectionTest.error || 'Connexion SFTP échouée';
      }
    } catch (error) {
      connectionError = error.message;
    }

    // Générer la page HTML avec les tabs
    const html = generateSftpBrowserHtml(files, remoteDir, connectionError, activeTab);
    res.send(html);
  })
);

/**
 * Génère la page HTML du navigateur SFTP
 */
function generateSftpBrowserHtml(files, remoteDir, error, activeTab = 'in') {
  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    return date.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const filesHtml = error
    ? `<div class="error-box">❌ Erreur de connexion SFTP: ${error}</div>`
    : files.length === 0
      ? '<div class="empty-box">📂 Aucun fichier dans ce dossier</div>'
      : `
        <table class="files-table">
          <thead>
            <tr>
              <th>📄 Nom du fichier</th>
              <th>📏 Taille</th>
              <th>📅 Date de modification</th>
              <th>⚡ Actions</th>
            </tr>
          </thead>
          <tbody>
            ${files.map(file => `
              <tr>
                <td class="filename">${file.name}</td>
                <td class="size">${formatSize(file.size)}</td>
                <td class="date">${formatDate(file.modifyTime)}</td>
                <td class="actions">
                  <a href="/test/sftp-file/${encodeURIComponent(file.name)}?dir=${encodeURIComponent(remoteDir)}&download=true" class="btn btn-download" title="Télécharger">
                    ⬇️ Télécharger
                  </a>
                  <a href="/test/sftp-file/${encodeURIComponent(file.name)}?dir=${encodeURIComponent(remoteDir)}" class="btn btn-view" title="Voir le contenu" target="_blank">
                    👁️ Voir
                  </a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SFTP Browser - Ophtalmic Gateway</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
      padding: 20px;
      margin: 0;
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      color: #fff;
      border-bottom: 2px solid #4a90d9;
      padding-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .info-box {
      background: #16213e;
      border-radius: 8px;
      padding: 15px 20px;
      margin-bottom: 20px;
      border-left: 4px solid #4a90d9;
    }
    .info-box strong {
      color: #4a90d9;
    }
    .error-box {
      background: #3d1a1a;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      border-left: 4px solid #dc3545;
      color: #ff6b6b;
    }
    .empty-box {
      background: #1a2a3e;
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      color: #888;
      font-size: 18px;
    }
    .files-table {
      width: 100%;
      border-collapse: collapse;
      background: #16213e;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    }
    .files-table th {
      background: #0f3460;
      padding: 15px;
      text-align: left;
      font-weight: 600;
      color: #4a90d9;
      border-bottom: 2px solid #4a90d9;
    }
    .files-table td {
      padding: 12px 15px;
      border-bottom: 1px solid #2a2a4a;
    }
    .files-table tr:hover {
      background: #1a2a4e;
    }
    .files-table tr:last-child td {
      border-bottom: none;
    }
    .filename {
      font-family: 'Courier New', monospace;
      color: #7ec8e3;
      font-weight: 500;
    }
    .size {
      color: #888;
      font-size: 14px;
    }
    .date {
      color: #888;
      font-size: 14px;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 8px 12px;
      border-radius: 5px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s ease;
    }
    .btn-download {
      background: #28a745;
      color: white;
    }
    .btn-download:hover {
      background: #218838;
      transform: translateY(-1px);
    }
    .btn-view {
      background: #4a90d9;
      color: white;
    }
    .btn-view:hover {
      background: #357abd;
      transform: translateY(-1px);
    }
    .refresh-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      background: #4a90d9;
      color: white;
      border: none;
      border-radius: 5px;
      font-size: 14px;
      cursor: pointer;
      text-decoration: none;
      margin-bottom: 20px;
      transition: background 0.2s;
    }
    .refresh-btn:hover {
      background: #357abd;
    }
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .tab {
      padding: 12px 24px;
      background: #16213e;
      border: 2px solid #2a2a4a;
      border-radius: 8px;
      color: #888;
      text-decoration: none;
      font-weight: 500;
      transition: all 0.2s;
    }
    .tab:hover {
      background: #1a2a4e;
      border-color: #4a90d9;
      color: #fff;
    }
    .tab.active {
      background: #4a90d9;
      border-color: #4a90d9;
      color: white;
    }
    .tab-icon {
      margin-right: 8px;
    }
    .stats {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: #16213e;
      padding: 15px 25px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-value {
      font-size: 28px;
      font-weight: bold;
      color: #4a90d9;
    }
    .stat-label {
      font-size: 12px;
      color: #888;
      text-transform: uppercase;
    }
    .footer {
      text-align: center;
      color: #666;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #2a2a4a;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📁 SFTP Browser - Ophtalmic Gateway</h1>

    <div class="tabs">
      <a href="/test/sftp-browser?dir=in" class="tab ${activeTab === 'in' ? 'active' : ''}">
        <span class="tab-icon">📤</span>IN (Commandes)
      </a>
      <a href="/test/sftp-browser?dir=out" class="tab ${activeTab === 'out' ? 'active' : ''}">
        <span class="tab-icon">📥</span>OUT (Statuts)
      </a>
      <a href="/test/sftp-browser?dir=transactions" class="tab ${activeTab === 'transactions' ? 'active' : ''}">
        <span class="tab-icon">💰</span>Transactions
      </a>
    </div>

    <div class="info-box">
      <strong>📂 Dossier actuel:</strong> ${remoteDir}<br>
      <strong>🖥️ Serveur:</strong> ${config.sftp.host}:${config.sftp.port}<br>
      <strong>📋 Description:</strong> ${activeTab === 'in' ? 'Commandes envoyées vers l\'ERP' : activeTab === 'out' ? 'Fichiers de statut reçus de l\'ERP' : activeTab === 'transactions' ? 'Fichiers de transactions bancaires exportés' : 'Dossier personnalisé'}
    </div>

    <a href="/test/sftp-browser?dir=${activeTab}" class="refresh-btn">🔄 Rafraîchir</a>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-value">${files.length}</div>
        <div class="stat-label">Fichiers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatSize(files.reduce((sum, f) => sum + (f.size || 0), 0))}</div>
        <div class="stat-label">Taille totale</div>
      </div>
    </div>

    ${filesHtml}

    <div class="footer">
      Ophtalmic Gateway Server - SFTP Browser<br>
      Dernière actualisation: ${new Date().toLocaleString('fr-FR')}
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * GET /test/last-webhook
 *
 * Affiche les données du dernier webhook orders/paid reçu.
 * Utile pour vérifier exactement ce que Shopify envoie (remises, prix, etc.)
 *
 * @route GET /test/last-webhook
 */
router.get('/last-webhook', (req, res) => {
  const lastOrder = webhookRoutes.getLastReceivedOrder();

  if (!lastOrder) {
    return res.json({
      success: false,
      message: 'Aucun webhook reçu depuis le démarrage du serveur',
      tip: 'Faites une vraie commande Shopify ou attendez un webhook pour voir les données',
    });
  }

  res.json({
    success: true,
    message: 'Dernier webhook orders/paid reçu',
    data: lastOrder,
  });
});

/**
 * GET /test/status-sync/preview
 *
 * Prévisualise les fichiers de statut dans /out/ sans les traiter.
 * Utile pour vérifier le contenu avant de lancer la synchronisation.
 *
 * @route GET /test/status-sync/preview
 */
router.get(
  '/status-sync/preview',
  asyncHandler(async (req, res) => {
    log.info('Prévisualisation des fichiers de statut');

    try {
      const result = await orderStatusSyncService.previewStatusFiles();

      res.json({
        success: true,
        message: 'Prévisualisation des fichiers de statut',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la prévisualisation', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * POST /test/status-sync/run
 *
 * Lance manuellement la synchronisation des statuts de commandes.
 * Lit les fichiers dans /out/, met à jour Shopify et archive les fichiers traités.
 *
 * @route POST /test/status-sync/run
 */
router.post(
  '/status-sync/run',
  asyncHandler(async (req, res) => {
    log.info('Lancement manuel de la synchronisation des statuts');

    try {
      const result = await statusSyncJob.executeStatusSync();

      res.json({
        success: true,
        message: 'Synchronisation des statuts terminée',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur lors de la synchronisation', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/status-sync/stats
 *
 * Récupère les statistiques du job de synchronisation des statuts.
 *
 * @route GET /test/status-sync/stats
 */
router.get('/status-sync/stats', (req, res) => {
  const stats = statusSyncJob.getStats();

  res.json({
    success: true,
    message: 'Statistiques de synchronisation des statuts',
    stats,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /test/sftp/in
 *
 * Liste les fichiers dans le dossier /in/ (commandes envoyées).
 *
 * @route GET /test/sftp/in
 */
router.get(
  '/sftp/in',
  asyncHandler(async (req, res) => {
    const remoteDir = config.sftp.remoteDirIn;

    log.info('Liste des fichiers dans /in/', { remoteDir });

    try {
      const files = await sftpService.listFiles(remoteDir);

      res.json({
        success: true,
        directory: remoteDir,
        description: 'Commandes envoyées vers ERP',
        fileCount: files.length,
        files,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur liste fichiers /in/', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/sftp/out
 *
 * Liste les fichiers dans le dossier /out/ (statuts reçus de l'ERP).
 *
 * @route GET /test/sftp/out
 */
router.get(
  '/sftp/out',
  asyncHandler(async (req, res) => {
    const remoteDir = config.sftp.remoteDirOut;

    log.info('Liste des fichiers dans /out/', { remoteDir });

    try {
      const files = await sftpService.listFiles(remoteDir);

      res.json({
        success: true,
        directory: remoteDir,
        description: 'Fichiers de statut reçus de ERP',
        fileCount: files.length,
        files,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur liste fichiers /out/', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/sftp/transactions
 *
 * Liste les fichiers dans le dossier /Transactions/ (exports bancaires).
 *
 * @route GET /test/sftp/transactions
 */
router.get(
  '/sftp/transactions',
  asyncHandler(async (req, res) => {
    const remoteDir = config.sftp.remoteDirTransactions;

    log.info('Liste des fichiers dans /Transactions/', { remoteDir });

    try {
      const files = await sftpService.listFiles(remoteDir);

      res.json({
        success: true,
        directory: remoteDir,
        description: 'Fichiers de transactions bancaires exportés',
        fileCount: files.length,
        files,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur liste fichiers /Transactions/', { error: error.message });

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

// ============================================
// ROUTES TRANSACTIONS BANCAIRES
// ============================================

/**
 * GET /test/transactions/payouts
 *
 * Liste les derniers payouts Shopify Payments avec leur statut d'export.
 *
 * @route GET /test/transactions/payouts
 * @param {number} [query.limit=20] - Nombre de payouts à récupérer
 */
router.get(
  '/transactions/payouts',
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;

    log.info('Liste des payouts', { limit });

    try {
      const result = await transactionExportService.listPayouts(limit);

      res.json({
        success: true,
        message: 'Liste des payouts Shopify Payments',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur liste payouts', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/transactions/preview/:payoutId
 *
 * Prévisualise le fichier de transaction sans l'envoyer.
 * Permet de voir le contenu du fichier avant export.
 *
 * @route GET /test/transactions/preview/:payoutId
 */
router.get(
  '/transactions/preview/:payoutId',
  asyncHandler(async (req, res) => {
    const { payoutId } = req.params;

    log.info('Prévisualisation du fichier de transaction', { payoutId });

    try {
      const result = await transactionExportService.previewPayoutFile(payoutId);

      res.json({
        success: true,
        message: 'Prévisualisation du fichier de transaction',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur prévisualisation transaction', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/transactions/download/:payoutId
 *
 * Télécharge le fichier de transaction en TXT.
 * Génère le fichier à la volée et le renvoie au navigateur.
 *
 * @route GET /test/transactions/download/:payoutId
 */
router.get(
  '/transactions/download/:payoutId',
  asyncHandler(async (req, res) => {
    const { payoutId } = req.params;

    log.info('Téléchargement du fichier de transaction', { payoutId });

    try {
      const result = await transactionExportService.previewPayoutFile(payoutId);

      if (!result.success) {
        return res.status(404).json({
          success: false,
          error: result.error,
        });
      }

      // Définir les headers pour le téléchargement
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);

      res.send(result.fileContent);
    } catch (error) {
      log.error('Erreur téléchargement transaction', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * POST /test/transactions/export/:payoutId
 *
 * Exporte manuellement un payout vers SFTP.
 *
 * @route POST /test/transactions/export/:payoutId
 * @param {boolean} [query.force=false] - Forcer l'export même si déjà exporté
 * @param {boolean} [query.testMode=false] - Sauvegarder localement au lieu d'envoyer SFTP
 */
router.post(
  '/transactions/export/:payoutId',
  asyncHandler(async (req, res) => {
    const { payoutId } = req.params;
    const force = req.query.force === 'true';
    const testMode = req.query.testMode === 'true' || config.test.testMode;

    log.info('Export manuel du payout', { payoutId, force, testMode });

    try {
      const result = await transactionExportService.exportPayout(payoutId, {
        force,
        testMode,
      });

      res.json({
        success: true,
        message: result.skipped
          ? 'Payout déjà exporté (utilisez ?force=true pour forcer)'
          : 'Payout exporté avec succès',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur export payout', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * POST /test/transactions/export-all
 *
 * Exporte tous les payouts en attente (non encore exportés).
 *
 * @route POST /test/transactions/export-all
 * @param {boolean} [query.testMode=false] - Sauvegarder localement
 */
router.post(
  '/transactions/export-all',
  asyncHandler(async (req, res) => {
    const testMode = req.query.testMode === 'true' || config.test.testMode;

    log.info('Export de tous les payouts en attente', { testMode });

    try {
      const result = await transactionExportService.exportAllPendingPayouts({
        testMode,
      });

      res.json({
        success: true,
        message: 'Export des payouts terminé',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur export all payouts', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * POST /test/transactions/sync/run
 *
 * Lance manuellement le job de synchronisation des transactions.
 *
 * @route POST /test/transactions/sync/run
 */
router.post(
  '/transactions/sync/run',
  asyncHandler(async (req, res) => {
    log.info('Lancement manuel de la synchronisation des transactions');

    try {
      const result = await transactionSyncJob.executeTransactionExport();

      res.json({
        success: true,
        message: 'Synchronisation des transactions terminée',
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur sync transactions', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/transactions/sync/stats
 *
 * Récupère les statistiques du job de synchronisation des transactions.
 *
 * @route GET /test/transactions/sync/stats
 */
router.get('/transactions/sync/stats', (req, res) => {
  const stats = transactionSyncJob.getStats();

  res.json({
    success: true,
    message: 'Statistiques du job d\'export des transactions',
    stats,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /test/transactions/reset
 *
 * Réinitialise la liste des payouts déjà exportés.
 * Utile pour forcer un ré-export complet.
 *
 * @route POST /test/transactions/reset
 */
router.post(
  '/transactions/reset',
  asyncHandler(async (req, res) => {
    log.info('Réinitialisation de la liste des payouts exportés');

    try {
      await transactionExportService.resetExportedPayouts();

      res.json({
        success: true,
        message: 'Liste des payouts exportés réinitialisée',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Erreur reset payouts', { error: error.message });

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  })
);

/**
 * GET /test/debug-sftp
 *
 * Route de debug SFTP avec affichage détaillé étape par étape.
 * Affiche directement en HTML pour capture d'écran.
 * Timeout réduit à 20s pour éviter le timeout Heroku (30s max).
 *
 * @route GET /test/debug-sftp
 */
router.get(
  '/debug-sftp',
  asyncHandler(async (req, res) => {
    const SftpClient = require('ssh2-sftp-client');
    const { SocksClient } = require('socks');
    const axios = require('axios');
    const { SocksProxyAgent } = require('socks-proxy-agent');

    const steps = [];
    const startTime = Date.now();
    const TIMEOUT = 20000; // 20 secondes (< 30s Heroku limit)

    // Helper pour ajouter une étape
    const addStep = (step, status, details = {}) => {
      steps.push({
        step,
        status,
        time: `${Date.now() - startTime}ms`,
        ...details,
      });
    };

    // Début
    addStep('🚀 Démarrage du test de connexion SFTP', 'info', {
      timestamp: new Date().toISOString(),
    });

    // Étape 1: Configuration
    const sftpHost = config.sftp.host;
    const sftpPort = config.sftp.port;
    const sftpUser = config.sftp.user;
    const fixieSocksHost = process.env.FIXIE_SOCKS_HOST;

    addStep('📋 Configuration SFTP', 'info', {
      host: sftpHost,
      port: sftpPort,
      user: sftpUser,
      proxyConfigured: !!fixieSocksHost,
    });

    // Étape 2: Parser le proxy
    let proxyConfig = null;
    let fixieIPs = ['52.209.179.93', '52.51.139.66'];

    if (fixieSocksHost) {
      try {
        const [credentials, hostPort] = fixieSocksHost.split('@');
        const [username, password] = credentials.split(':');
        const [host, port] = hostPort.split(':');
        proxyConfig = { host, port: parseInt(port, 10), type: 5, userId: username, password };

        addStep('🔐 Proxy SOCKS5 Fixie configuré', 'success', {
          proxyHost: host,
          proxyPort: port,
          expectedOutboundIPs: fixieIPs.join(', '),
        });
      } catch (err) {
        addStep('❌ Erreur parsing proxy', 'error', { error: err.message });
      }
    } else {
      addStep('⚠️ Pas de proxy SOCKS5 configuré', 'warning', {
        message: 'Les requêtes utilisent l\'IP dynamique Heroku',
      });
    }

    // Étape 3: Vérification de l'IP sortante via le proxy
    if (fixieSocksHost) {
      addStep('🔄 Vérification de l\'IP sortante via le proxy...', 'info', {
        service: 'api.ipify.org',
      });

      try {
        const proxyUrl = `socks5://${fixieSocksHost}`;
        const socksAgent = new SocksProxyAgent(proxyUrl);

        const ipResponse = await axios.get('https://api.ipify.org?format=json', {
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: 10000,
        });

        const detectedIP = ipResponse.data.ip;
        const isFixieIP = fixieIPs.includes(detectedIP);

        addStep(isFixieIP ? '✅ IP sortante vérifiée' : '⚠️ IP sortante inattendue', isFixieIP ? 'success' : 'warning', {
          detectedIP: detectedIP,
          isFixieIP: isFixieIP,
          expectedIPs: fixieIPs.join(', '),
          message: isFixieIP
            ? `L'IP ${detectedIP} est bien une IP Fixie - C'est cette IP qui doit être whitelistée`
            : `L'IP ${detectedIP} n'est pas dans la liste Fixie attendue`,
        });
      } catch (ipError) {
        addStep('⚠️ Impossible de vérifier l\'IP sortante', 'warning', {
          error: ipError.message,
          note: 'Le test continue avec les IPs Fixie attendues',
        });
      }
    }

    // Étape 4: Création connexion SOCKS5 vers SFTP
    let socksSocket = null;
    if (proxyConfig) {
      addStep('🔄 Tentative de connexion via proxy SOCKS5...', 'info', {
        target: `${sftpHost}:${sftpPort}`,
        viaProxy: `${proxyConfig.host}:${proxyConfig.port}`,
        expectedIP: fixieIPs.join(' ou '),
      });

      try {
        const connectionStart = Date.now();
        const { socket } = await SocksClient.createConnection({
          proxy: proxyConfig,
          command: 'connect',
          destination: { host: sftpHost, port: sftpPort },
          timeout: TIMEOUT,
        });
        socksSocket = socket;

        addStep('✅ Tunnel SOCKS5 établi', 'success', {
          duration: `${Date.now() - connectionStart}ms`,
          message: `Connexion via IP statique Fixie vers ${sftpHost}:${sftpPort}`,
        });
      } catch (socksError) {
        addStep('❌ Échec connexion SOCKS5', 'error', {
          error: socksError.message,
          code: socksError.code,
          possibleCauses: [
            'Le serveur SFTP ne répond pas',
            'IP non whitelistée sur le firewall',
            `IPs à whitelister: ${fixieIPs.join(', ')}`,
          ],
        });
      }
    }

    // Étape 5: Connexion SFTP
    const sftp = new SftpClient();
    let sftpConnected = false;

    if (socksSocket || !proxyConfig) {
      addStep('🔄 Tentative de connexion SFTP...', 'info', {
        host: sftpHost,
        port: sftpPort,
        user: sftpUser,
        viaProxy: !!socksSocket,
      });

      try {
        const sftpConfig = {
          host: sftpHost,
          port: sftpPort,
          username: sftpUser,
          password: config.sftp.password,
          readyTimeout: TIMEOUT,
        };

        if (socksSocket) {
          sftpConfig.sock = socksSocket;
        }

        const sftpStart = Date.now();
        await sftp.connect(sftpConfig);
        sftpConnected = true;

        addStep('✅ Connexion SFTP réussie!', 'success', {
          duration: `${Date.now() - sftpStart}ms`,
          message: 'Authentification SSH réussie',
        });

        // Étape 6: Lister le dossier
        try {
          const cwd = await sftp.cwd();
          addStep('📂 Répertoire courant', 'success', { cwd });

          const remoteDir = config.sftp.remoteDir;
          const dirExists = await sftp.exists(remoteDir);
          if (dirExists) {
            const files = await sftp.list(remoteDir);
            addStep('📁 Contenu du dossier distant', 'success', {
              directory: remoteDir,
              fileCount: files.length,
              files: files.slice(0, 5).map(f => f.name),
            });
          } else {
            addStep('⚠️ Dossier distant non trouvé', 'warning', { directory: remoteDir });
          }
        } catch (listError) {
          addStep('⚠️ Erreur lecture dossier', 'warning', { error: listError.message });
        }

      } catch (sftpError) {
        addStep('❌ Échec connexion SFTP', 'error', {
          error: sftpError.message,
          code: sftpError.code,
          level: sftpError.level,
          possibleCauses: [
            'IP non whitelistée sur le serveur SFTP',
            'Identifiants incorrects',
            'Serveur SFTP inaccessible',
            `IPs à whitelister: ${fixieIPs.join(', ')}`,
          ],
        });
      }
    } else {
      addStep('⏭️ Connexion SFTP ignorée', 'warning', {
        reason: 'Le tunnel SOCKS5 n\'a pas pu être établi',
      });
    }

    // Fermeture
    if (sftpConnected) {
      try {
        await sftp.end();
        addStep('🔒 Connexion SFTP fermée', 'info');
      } catch (e) {}
    }

    // Résumé final
    const totalDuration = Date.now() - startTime;
    const hasError = steps.some(s => s.status === 'error');

    addStep(hasError ? '❌ TEST ÉCHOUÉ' : '✅ TEST RÉUSSI', hasError ? 'error' : 'success', {
      totalDuration: `${totalDuration}ms`,
      conclusion: hasError
        ? 'La connexion SFTP a échoué. Vérifiez que les IPs Fixie sont whitelistées.'
        : 'La connexion SFTP fonctionne correctement!',
    });

    // Générer HTML
    const html = generateDebugHtml('Test de connexion SFTP', steps, {
      fixieIPs,
      target: `${sftpHost}:${sftpPort}`,
    });

    res.send(html);
  })
);

/**
 * GET /test/debug-sage
 *
 * Route de debug Sage X3 avec affichage détaillé étape par étape.
 * Affiche directement en HTML pour capture d'écran.
 * Timeout réduit à 20s pour éviter le timeout Heroku (30s max).
 *
 * @route GET /test/debug-sage
 */
router.get(
  '/debug-sage',
  asyncHandler(async (req, res) => {
    const soap = require('soap');
    const axios = require('axios');
    const { SocksProxyAgent } = require('socks-proxy-agent');

    const steps = [];
    const startTime = Date.now();
    const TIMEOUT = 20000; // 20 secondes (< 30s Heroku limit)

    // Helper pour ajouter une étape
    const addStep = (step, status, details = {}) => {
      steps.push({
        step,
        status,
        time: `${Date.now() - startTime}ms`,
        ...details,
      });
    };

    // Début
    addStep('🚀 Démarrage du test de connexion Sage X3', 'info', {
      timestamp: new Date().toISOString(),
    });

    // Étape 1: Configuration
    const wsdlUrl = config.sageX3.wsdlUrl;
    const fixieSocksHost = process.env.FIXIE_SOCKS_HOST;
    let fixieIPs = ['52.209.179.93', '52.51.139.66'];

    // Extraire host et port du WSDL URL
    const wsdlUrlParsed = new URL(wsdlUrl);
    const sageHost = wsdlUrlParsed.hostname;
    const sagePort = wsdlUrlParsed.port || 443;

    addStep('📋 Configuration Sage X3', 'info', {
      wsdlUrl: wsdlUrl,
      host: sageHost,
      port: sagePort,
      user: config.sageX3.user,
      poolAlias: config.sageX3.poolAlias,
      proxyConfigured: !!fixieSocksHost,
    });

    // Étape 2: Configuration proxy
    let socksAgent = null;

    if (fixieSocksHost) {
      try {
        const proxyUrl = `socks5://${fixieSocksHost}`;
        socksAgent = new SocksProxyAgent(proxyUrl);

        const [, hostPort] = fixieSocksHost.split('@');
        const [proxyHost, proxyPort] = hostPort.split(':');

        addStep('🔐 Proxy SOCKS5 Fixie configuré', 'success', {
          proxyHost,
          proxyPort,
          expectedOutboundIPs: fixieIPs.join(', '),
        });
      } catch (err) {
        addStep('❌ Erreur configuration proxy', 'error', { error: err.message });
      }
    } else {
      addStep('⚠️ Pas de proxy SOCKS5 configuré', 'warning', {
        message: 'Les requêtes utilisent l\'IP dynamique Heroku',
      });
    }

    // Étape 3: Vérification de l'IP sortante via le proxy
    if (socksAgent) {
      addStep('🔄 Vérification de l\'IP sortante via le proxy...', 'info', {
        service: 'api.ipify.org',
      });

      try {
        const ipResponse = await axios.get('https://api.ipify.org?format=json', {
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: 10000,
        });

        const detectedIP = ipResponse.data.ip;
        const isFixieIP = fixieIPs.includes(detectedIP);

        addStep(isFixieIP ? '✅ IP sortante vérifiée' : '⚠️ IP sortante inattendue', isFixieIP ? 'success' : 'warning', {
          detectedIP: detectedIP,
          isFixieIP: isFixieIP,
          expectedIPs: fixieIPs.join(', '),
          message: isFixieIP
            ? `L'IP ${detectedIP} est bien une IP Fixie - C'est cette IP qui doit être whitelistée`
            : `L'IP ${detectedIP} n'est pas dans la liste Fixie attendue`,
        });
      } catch (ipError) {
        addStep('⚠️ Impossible de vérifier l\'IP sortante', 'warning', {
          error: ipError.message,
          note: 'Le test continue avec les IPs Fixie attendues',
        });
      }
    }

    // Étape 4: Test de connectivité TCP au serveur
    addStep('🔄 Tentative de connexion vers Sage X3...', 'info', {
      target: `${sageHost}:${sagePort}`,
      viaProxy: socksAgent ? 'Oui (IP Fixie)' : 'Non (IP Heroku dynamique)',
      timeout: `${TIMEOUT}ms`,
    });

    // Étape 5: Tentative de récupération du WSDL
    try {
      const soapOptions = {
        wsdl_options: {
          auth: {
            user: config.sageX3.user,
            pass: config.sageX3.password,
          },
          rejectUnauthorized: false,
          timeout: TIMEOUT,
          agent: socksAgent,
        },
      };

      const wsdlStart = Date.now();
      const client = await soap.createClientAsync(wsdlUrl, soapOptions);

      addStep('✅ WSDL récupéré avec succès!', 'success', {
        duration: `${Date.now() - wsdlStart}ms`,
        message: 'Le serveur Sage X3 a répondu',
      });

      // Lister les méthodes disponibles
      const description = client.describe();
      const services = Object.keys(description);
      const methods = [];

      for (const serviceName of services) {
        const service = description[serviceName];
        for (const portName of Object.keys(service)) {
          const port = service[portName];
          methods.push(...Object.keys(port));
        }
      }

      addStep('📋 Méthodes SOAP disponibles', 'success', {
        services: services,
        methods: methods,
      });

      // Configurer le client pour un test
      client.setSecurity(
        new soap.BasicAuthSecurity(config.sageX3.user, config.sageX3.password)
      );

      if (socksAgent) {
        client.httpClient.options = client.httpClient.options || {};
        client.httpClient.options.agent = socksAgent;
      }

      addStep('✅ Client SOAP configuré', 'success', {
        authMethod: 'Basic Auth',
        proxyEnabled: !!socksAgent,
      });

    } catch (soapError) {
      const errorDetails = {
        error: soapError.message,
        code: soapError.code,
      };

      if (soapError.message.includes('timeout') || soapError.message.includes('ETIMEDOUT') || soapError.message.includes('ESOCKETTIMEDOUT')) {
        errorDetails.possibleCauses = [
          'Les IPs Fixie ne sont pas whitelistées sur le firewall Sage X3',
          `IPs à whitelister: ${fixieIPs.join(', ')}`,
          'Le serveur Sage X3 est inaccessible',
          'Le port est bloqué',
        ];
      } else if (soapError.message.includes('ECONNREFUSED')) {
        errorDetails.possibleCauses = [
          'Le serveur refuse la connexion',
          'Le service SOAP n\'est pas démarré',
        ];
      } else if (soapError.message.includes('401') || soapError.message.includes('Unauthorized')) {
        errorDetails.possibleCauses = [
          'Identifiants incorrects',
          'Compte utilisateur bloqué',
        ];
      } else if (soapError.message.includes('ENOTFOUND')) {
        errorDetails.possibleCauses = [
          'Le nom de domaine n\'existe pas',
          'Erreur DNS',
        ];
      }

      addStep('❌ Échec connexion Sage X3', 'error', errorDetails);
    }

    // Résumé final
    const totalDuration = Date.now() - startTime;
    const hasError = steps.some(s => s.status === 'error');

    addStep(hasError ? '❌ TEST ÉCHOUÉ' : '✅ TEST RÉUSSI', hasError ? 'error' : 'success', {
      totalDuration: `${totalDuration}ms`,
      conclusion: hasError
        ? 'La connexion Sage X3 a échoué. Vérifiez que les IPs Fixie sont whitelistées sur le firewall.'
        : 'La connexion Sage X3 fonctionne correctement!',
    });

    // Générer HTML
    const html = generateDebugHtml('Test de connexion Sage X3', steps, {
      fixieIPs,
      target: `${sageHost}:${sagePort}`,
    });

    res.send(html);
  })
);

/**
 * Génère une page HTML formatée pour les résultats de debug
 */
function generateDebugHtml(title, steps, info) {
  const statusColors = {
    success: '#28a745',
    error: '#dc3545',
    warning: '#ffc107',
    info: '#17a2b8',
  };

  const stepsHtml = steps.map(step => {
    const color = statusColors[step.status] || '#6c757d';
    const details = Object.entries(step)
      .filter(([key]) => !['step', 'status', 'time'].includes(key))
      .map(([key, value]) => {
        const displayValue = Array.isArray(value)
          ? value.map(v => `<li>${v}</li>`).join('')
          : typeof value === 'object'
            ? JSON.stringify(value, null, 2)
            : value;
        return `<div class="detail"><strong>${key}:</strong> ${Array.isArray(value) ? `<ul>${displayValue}</ul>` : displayValue}</div>`;
      })
      .join('');

    return `
      <div class="step" style="border-left: 4px solid ${color};">
        <div class="step-header">
          <span class="step-title">${step.step}</span>
          <span class="step-time">${step.time}</span>
        </div>
        ${details ? `<div class="step-details">${details}</div>` : ''}
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Debug</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      padding: 20px;
      margin: 0;
      line-height: 1.6;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    h1 {
      color: #fff;
      border-bottom: 2px solid #4a90d9;
      padding-bottom: 10px;
    }
    .info-box {
      background: #16213e;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
    }
    .info-box h3 {
      margin-top: 0;
      color: #4a90d9;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid #2a2a4a;
    }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #888; }
    .info-value { color: #4a90d9; font-weight: bold; }
    .step {
      background: #16213e;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 10px;
    }
    .step-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .step-title {
      font-weight: bold;
      font-size: 16px;
    }
    .step-time {
      color: #888;
      font-size: 12px;
    }
    .step-details {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #2a2a4a;
      font-size: 14px;
    }
    .detail {
      margin: 5px 0;
      word-break: break-all;
    }
    .detail strong {
      color: #4a90d9;
    }
    .detail ul {
      margin: 5px 0 5px 20px;
      padding: 0;
    }
    .footer {
      text-align: center;
      color: #666;
      margin-top: 30px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔍 ${title}</h1>

    <div class="info-box">
      <h3>📡 Informations de connexion</h3>
      <div class="info-row">
        <span class="info-label">Serveur cible:</span>
        <span class="info-value">${info.target}</span>
      </div>
      <div class="info-row">
        <span class="info-label">IPs statiques Fixie (à whitelister):</span>
        <span class="info-value">${info.fixieIPs.join(', ')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Date du test:</span>
        <span class="info-value">${new Date().toLocaleString('fr-FR')}</span>
      </div>
    </div>

    <h2>📝 Étapes du test</h2>
    ${stepsHtml}

    <div class="footer">
      Ophtalmic Gateway Server - Debug Report<br>
      Généré le ${new Date().toISOString()}
    </div>
  </div>
</body>
</html>
  `;
}

module.exports = router;
