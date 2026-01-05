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

/**
 * GET /test/debug-sftp
 *
 * Route de debug SFTP avec affichage détaillé étape par étape.
 * Affiche directement en HTML pour capture d'écran.
 *
 * @route GET /test/debug-sftp
 */
router.get(
  '/debug-sftp',
  asyncHandler(async (req, res) => {
    const SftpClient = require('ssh2-sftp-client');
    const { SocksClient } = require('socks');

    const steps = [];
    const startTime = Date.now();

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

    // Étape 3: Création connexion SOCKS5 vers SFTP
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
          timeout: 30000,
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
          possibleCause: 'Le serveur SFTP ne répond pas ou IP non whitelistée',
        });
      }
    }

    // Étape 4: Connexion SFTP
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
          readyTimeout: 20000,
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

        // Étape 5: Lister le dossier
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
 *
 * @route GET /test/debug-sage
 */
router.get(
  '/debug-sage',
  asyncHandler(async (req, res) => {
    const soap = require('soap');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const https = require('https');

    const steps = [];
    const startTime = Date.now();

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

    // Étape 3: Test de connectivité TCP au serveur
    addStep('🔄 Test de connectivité vers le serveur Sage X3...', 'info', {
      target: `${sageHost}:${sagePort}`,
      viaProxy: socksAgent ? 'Oui (IP Fixie)' : 'Non (IP Heroku dynamique)',
      expectedIP: socksAgent ? fixieIPs.join(' ou ') : 'IP dynamique Heroku',
    });

    // Étape 4: Tentative de récupération du WSDL
    addStep('🔄 Tentative de récupération du WSDL...', 'info', {
      url: wsdlUrl,
      timeout: `${config.security.apiTimeout}ms`,
    });

    try {
      const soapOptions = {
        wsdl_options: {
          auth: {
            user: config.sageX3.user,
            pass: config.sageX3.password,
          },
          rejectUnauthorized: false,
          timeout: config.security.apiTimeout,
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

      if (soapError.message.includes('timeout') || soapError.message.includes('ETIMEDOUT')) {
        errorDetails.possibleCauses = [
          'Les IPs Fixie ne sont pas whitelistées sur le firewall Sage X3',
          `IPs à whitelister: ${fixieIPs.join(', ')}`,
          'Le serveur Sage X3 est inaccessible',
          'Le port 4433 est bloqué',
        ];
        errorDetails.recommendation = 'Demander au client de whitelister les IPs Fixie';
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
      }

      addStep('❌ Échec récupération WSDL', 'error', errorDetails);
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
