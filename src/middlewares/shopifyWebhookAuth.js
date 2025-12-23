/**
 * Middleware d'authentification des webhooks Shopify
 *
 * Ce middleware vérifie l'authenticité des webhooks Shopify en validant
 * la signature HMAC-SHA256 incluse dans l'en-tête de la requête.
 *
 * Shopify signe chaque webhook avec le secret partagé configuré dans
 * l'application. Cette signature garantit que :
 * 1. Le webhook provient bien de Shopify
 * 2. Le contenu n'a pas été modifié en transit
 *
 * @module middlewares/shopifyWebhookAuth
 */

const crypto = require('crypto');
const { config } = require('../config/env');
const { webhookLogger } = require('../utils/logger');

// Logger dédié aux webhooks
const log = webhookLogger;

/**
 * Middleware de vérification HMAC pour les webhooks Shopify
 *
 * Ce middleware doit être appliqué AVANT le middleware body-parser JSON
 * car il a besoin du body brut pour calculer le HMAC.
 *
 * Configuration Express requise :
 * ```javascript
 * // Route webhook avec body brut
 * app.use('/webhook', express.raw({ type: 'application/json' }));
 * app.use('/webhook', verifyShopifyWebhook);
 *
 * // Autres routes avec JSON parser
 * app.use(express.json());
 * ```
 *
 * @param {Object} req - Requête Express
 * @param {Object} res - Réponse Express
 * @param {Function} next - Fonction next
 */
function verifyShopifyWebhook(req, res, next) {
  log.info('Vérification du webhook Shopify', {
    path: req.path,
    method: req.method,
    ip: req.ip,
    shopifyTopic: req.headers['x-shopify-topic'],
    shopifyDomain: req.headers['x-shopify-shop-domain'],
  });

  // En mode développement sans secret configuré, on peut bypasser la vérification
  if (!config.shopify.webhookSecret) {
    if (config.server.isDevelopment) {
      log.warn('Secret webhook non configuré - Vérification désactivée en dev');
      return parseAndContinue(req, res, next);
    } else {
      log.error('Secret webhook non configuré en production');
      return res.status(500).json({
        error: 'Configuration webhook incorrecte',
      });
    }
  }

  // Récupérer la signature HMAC de l'en-tête
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!hmacHeader) {
    log.warn('Header HMAC manquant dans la requête webhook', {
      headers: Object.keys(req.headers),
    });

    return res.status(401).json({
      error: 'Signature HMAC manquante',
    });
  }

  // Récupérer le body brut
  const rawBody = req.body;

  if (!rawBody) {
    log.error('Body de la requête vide ou non disponible');
    return res.status(400).json({
      error: 'Corps de la requête vide',
    });
  }

  // Le body doit être un Buffer (configuré avec express.raw())
  const bodyToHash = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

  // Calculer le HMAC du body avec le secret partagé
  const calculatedHmac = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(bodyToHash)
    .digest('base64');

  // Comparer les deux signatures de manière sécurisée (timing-safe)
  const isValid = safeCompare(calculatedHmac, hmacHeader);

  if (!isValid) {
    log.warn('Signature HMAC invalide', {
      receivedHmac: hmacHeader.substring(0, 10) + '...',
      calculatedHmac: calculatedHmac.substring(0, 10) + '...',
    });

    return res.status(401).json({
      error: 'Signature HMAC invalide',
    });
  }

  log.info('Signature HMAC valide - Webhook authentifié');

  // Parser le body JSON et continuer
  return parseAndContinue(req, res, next);
}

/**
 * Parse le body brut en JSON et continue vers le handler suivant
 *
 * @param {Object} req - Requête Express
 * @param {Object} res - Réponse Express
 * @param {Function} next - Fonction next
 */
function parseAndContinue(req, res, next) {
  try {
    // Si le body est un Buffer, le parser en JSON
    if (Buffer.isBuffer(req.body)) {
      req.body = JSON.parse(req.body.toString('utf-8'));
    } else if (typeof req.body === 'string') {
      req.body = JSON.parse(req.body);
    }

    // Ajouter des métadonnées utiles à la requête
    req.shopifyWebhook = {
      topic: req.headers['x-shopify-topic'],
      shopDomain: req.headers['x-shopify-shop-domain'],
      apiVersion: req.headers['x-shopify-api-version'],
      webhookId: req.headers['x-shopify-webhook-id'],
      triggeredAt: req.headers['x-shopify-triggered-at'],
    };

    log.debug('Body webhook parsé avec succès', {
      topic: req.shopifyWebhook.topic,
      orderId: req.body.id,
      orderName: req.body.name,
    });

    next();
  } catch (parseError) {
    log.error('Erreur lors du parsing du body webhook', {
      error: parseError.message,
    });

    return res.status(400).json({
      error: 'Format JSON invalide',
    });
  }
}

/**
 * Comparaison de chaînes sécurisée contre les timing attacks
 *
 * Utilise crypto.timingSafeEqual pour comparer les chaînes
 * de manière à ce que le temps de comparaison ne révèle pas
 * d'informations sur les différences entre les chaînes.
 *
 * @param {string} a - Première chaîne
 * @param {string} b - Deuxième chaîne
 * @returns {boolean} True si les chaînes sont identiques
 */
function safeCompare(a, b) {
  // Convertir en Buffers
  const bufferA = Buffer.from(a, 'utf-8');
  const bufferB = Buffer.from(b, 'utf-8');

  // Les buffers doivent avoir la même longueur pour timingSafeEqual
  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Middleware de vérification des IPs autorisées (optionnel)
 *
 * Shopify publie une liste d'IPs de leurs serveurs webhook.
 * Ce middleware peut être utilisé pour une vérification additionnelle.
 *
 * Note: Ce n'est pas obligatoire car la vérification HMAC est suffisante.
 *
 * @param {Object} req - Requête Express
 * @param {Object} res - Réponse Express
 * @param {Function} next - Fonction next
 */
function verifyAllowedIp(req, res, next) {
  // Si aucune IP n'est configurée, autoriser toutes les requêtes
  if (!config.security.allowedIps || config.security.allowedIps.length === 0) {
    return next();
  }

  // Récupérer l'IP du client (en tenant compte des proxies)
  const clientIp = req.ip
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection.remoteAddress;

  if (config.security.allowedIps.includes(clientIp)) {
    log.debug('IP autorisée', { clientIp });
    return next();
  }

  log.warn('IP non autorisée pour les webhooks', {
    clientIp,
    allowedIps: config.security.allowedIps,
  });

  return res.status(403).json({
    error: 'Accès refusé - IP non autorisée',
  });
}

/**
 * Middleware de logging des webhooks
 *
 * Log tous les webhooks reçus pour le débogage et l'audit.
 * Peut être utilisé avant ou après la vérification HMAC.
 *
 * @param {Object} req - Requête Express
 * @param {Object} res - Réponse Express
 * @param {Function} next - Fonction next
 */
function logWebhook(req, res, next) {
  const startTime = Date.now();

  // Intercepter la fin de la réponse
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    log.info('Webhook traité', {
      topic: req.headers['x-shopify-topic'],
      shopDomain: req.headers['x-shopify-shop-domain'],
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      orderId: req.body?.id,
      orderName: req.body?.name,
    });
  });

  next();
}

module.exports = {
  verifyShopifyWebhook,
  verifyAllowedIp,
  logWebhook,
  safeCompare,
};
