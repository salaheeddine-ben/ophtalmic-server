/**
 * Routes des webhooks Shopify
 *
 * Ce module définit les endpoints pour recevoir les webhooks Shopify.
 * Actuellement, seul le webhook orders/paid est implémenté.
 *
 * Les webhooks Shopify :
 * - Sont des requêtes POST avec un body JSON
 * - Incluent une signature HMAC dans le header X-Shopify-Hmac-Sha256
 * - Doivent répondre rapidement (< 5 secondes) avec un 200 OK
 * - Seront réessayés par Shopify en cas d'échec (jusqu'à 19 fois sur 48h)
 *
 * @module routes/webhookRoutes
 */

const express = require('express');
const asyncHandler = require('express-async-handler');
const { webhookLogger } = require('../utils/logger');
const orderExportService = require('../services/orderExportService');

// Logger dédié aux webhooks
const log = webhookLogger;

// Créer le router Express
const router = express.Router();

// Stockage en mémoire du dernier webhook reçu (pour debug)
let lastReceivedOrder = null;

/**
 * POST /webhook/orders/paid
 *
 * Endpoint pour recevoir le webhook "orders/paid" de Shopify.
 * Déclenché quand une commande est payée avec succès.
 *
 * Comportement :
 * 1. Répondre immédiatement 200 OK (pour éviter les retries Shopify)
 * 2. Traiter la commande en arrière-plan
 * 3. Générer et envoyer le fichier de commande (SFTP ou local selon config)
 *
 * @route POST /webhook/orders/paid
 * @param {Object} req.body - Données de la commande Shopify
 * @returns {Object} 200 OK avec message de confirmation
 */
router.post(
  '/orders/paid',
  asyncHandler(async (req, res) => {
    const order = req.body;
    const webhookMeta = req.shopifyWebhook || {};

    log.info('Webhook orders/paid reçu', {
      orderName: order.name,
      orderId: order.id,
      email: order.email,
      totalPrice: order.total_price,
      currency: order.currency,
      itemCount: order.line_items?.length,
      shopDomain: webhookMeta.shopDomain,
      webhookId: webhookMeta.webhookId,
    });

    // Sauvegarder le dernier webhook reçu pour debug (champs remise notamment)
    lastReceivedOrder = {
      receivedAt: new Date().toISOString(),
      orderName: order.name,
      orderId: order.id,
      total_price: order.total_price,
      total_tax: order.total_tax,
      total_discounts: order.total_discounts,
      discount_codes: order.discount_codes,
      discount_applications: order.discount_applications,
      line_items: (order.line_items || []).map(item => ({
        sku: item.sku,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        total_discount: item.total_discount,
        discount_allocations: item.discount_allocations,
      })),
    };

    // ============================================
    // IMPORTANT : Répondre immédiatement à Shopify
    // ============================================
    // Shopify attend une réponse dans les 5 secondes.
    // Le traitement de la commande se fait en arrière-plan.
    res.status(200).json({
      received: true,
      orderName: order.name,
      message: 'Commande reçue et en cours de traitement',
    });

    // ============================================
    // Traitement en arrière-plan
    // ============================================
    // Utiliser setImmediate pour ne pas bloquer la réponse
    setImmediate(async () => {
      try {
        log.info('Début du traitement de la commande', {
          orderName: order.name,
        });

        // Exporter la commande (vers SFTP ou fichier local selon config)
        const exportResult = await orderExportService.exportOrder(order);

        log.info('Commande traitée avec succès', {
          orderName: order.name,
          exportResult,
        });
      } catch (exportError) {
        // Logger l'erreur mais ne pas faire échouer le webhook
        // L'erreur sera visible dans les logs pour investigation
        log.error('Erreur lors du traitement de la commande', {
          orderName: order.name,
          orderId: order.id,
          error: exportError.message,
          stack: exportError.stack,
        });

        // TODO: Implémenter un système de retry/queue pour les échecs
        // Par exemple : stocker dans une file d'attente Redis
        // ou réessayer avec un délai exponentiel
      }
    });
  })
);

/**
 * POST /webhook/orders/create
 *
 * Endpoint optionnel pour le webhook "orders/create".
 * Déclenché quand une nouvelle commande est créée (avant paiement).
 *
 * Note: Généralement, on préfère traiter "orders/paid" car la commande
 * est confirmée et payée.
 *
 * @route POST /webhook/orders/create
 */
router.post(
  '/orders/create',
  asyncHandler(async (req, res) => {
    const order = req.body;

    log.info('Webhook orders/create reçu', {
      orderName: order.name,
      orderId: order.id,
      financialStatus: order.financial_status,
    });

    // Pour l'instant, on log simplement la création
    // Le traitement principal se fait sur orders/paid

    res.status(200).json({
      received: true,
      message: 'Création de commande notée - En attente de paiement',
    });
  })
);

/**
 * POST /webhook/orders/updated
 *
 * Endpoint optionnel pour le webhook "orders/updated".
 * Déclenché quand une commande est modifiée.
 *
 * @route POST /webhook/orders/updated
 */
router.post(
  '/orders/updated',
  asyncHandler(async (req, res) => {
    const order = req.body;

    log.info('Webhook orders/updated reçu', {
      orderName: order.name,
      orderId: order.id,
      financialStatus: order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
    });

    // TODO: Implémenter si besoin de gérer les modifications de commande
    // Par exemple : annulation, remboursement, etc.

    res.status(200).json({
      received: true,
      message: 'Mise à jour de commande reçue',
    });
  })
);

/**
 * POST /webhook/orders/cancelled
 *
 * Endpoint pour le webhook "orders/cancelled".
 * Déclenché quand une commande est annulée.
 *
 * @route POST /webhook/orders/cancelled
 */
router.post(
  '/orders/cancelled',
  asyncHandler(async (req, res) => {
    const order = req.body;

    log.info('Webhook orders/cancelled reçu', {
      orderName: order.name,
      orderId: order.id,
      cancelReason: order.cancel_reason,
    });

    // TODO: Implémenter si besoin d'envoyer une notification d'annulation à Sage X3
    // Cela pourrait impliquer de générer un fichier d'annulation spécifique

    res.status(200).json({
      received: true,
      message: 'Annulation de commande notée',
    });
  })
);

/**
 * POST /webhook/inventory_levels/update
 *
 * Endpoint optionnel pour le webhook "inventory_levels/update".
 * Déclenché quand le niveau d'inventaire change sur Shopify.
 *
 * Note: Ce webhook permet de détecter les modifications manuelles
 * sur Shopify et éventuellement les synchroniser avec Sage X3.
 *
 * @route POST /webhook/inventory_levels/update
 */
router.post(
  '/inventory_levels/update',
  asyncHandler(async (req, res) => {
    const inventoryLevel = req.body;

    log.info('Webhook inventory_levels/update reçu', {
      inventoryItemId: inventoryLevel.inventory_item_id,
      locationId: inventoryLevel.location_id,
      available: inventoryLevel.available,
    });

    // TODO: Implémenter si besoin de synchroniser les changements vers Sage X3

    res.status(200).json({
      received: true,
      message: 'Mise à jour d\'inventaire reçue',
    });
  })
);

/**
 * Route catch-all pour les webhooks non gérés
 *
 * Répond 200 OK pour éviter les retries, mais log un warning.
 */
router.post(
  '/*',
  asyncHandler(async (req, res) => {
    const topic = req.headers['x-shopify-topic'] || 'unknown';

    log.warn('Webhook non géré reçu', {
      topic,
      path: req.path,
    });

    res.status(200).json({
      received: true,
      message: `Webhook ${topic} reçu mais non traité`,
    });
  })
);

/**
 * GET /webhook/health
 *
 * Endpoint de santé pour vérifier que les webhooks sont accessibles.
 * Utile pour les tests et le monitoring.
 *
 * @route GET /webhook/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Endpoint webhook opérationnel',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Retourne le dernier webhook reçu (pour debug uniquement)
 */
function getLastReceivedOrder() {
  return lastReceivedOrder;
}

module.exports = router;
module.exports.getLastReceivedOrder = getLastReceivedOrder;
