/**
 * Service Shopify - Client pour l'API Admin Shopify
 *
 * Ce service gère toutes les interactions avec l'API Admin Shopify :
 * - Mise à jour des niveaux d'inventaire
 * - Récupération des informations produits/variants
 * - Gestion des emplacements (locations)
 *
 * L'API Admin Shopify utilise :
 * - Authentification via Access Token (X-Shopify-Access-Token)
 * - Format JSON
 * - Rate limiting (2 requêtes/seconde pour la plupart des endpoints)
 *
 * @module services/shopifyService
 */

const axios = require('axios');
const { config } = require('../config/env');
const { createModuleLogger } = require('../utils/logger');

// Logger dédié à ce module
const log = createModuleLogger('shopifyService');

/**
 * Crée une instance Axios configurée pour l'API Shopify
 * Avec gestion des headers d'authentification et du rate limiting
 */
function createShopifyClient() {
  const client = axios.create({
    baseURL: `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.accessToken,
    },
    timeout: config.security.apiTimeout,
  });

  // Intercepteur pour logger les requêtes
  client.interceptors.request.use(
    (requestConfig) => {
      log.debug('Requête Shopify', {
        method: requestConfig.method.toUpperCase(),
        url: requestConfig.url,
      });
      return requestConfig;
    },
    (error) => {
      log.error('Erreur de requête Shopify', { error: error.message });
      return Promise.reject(error);
    }
  );

  // Intercepteur pour gérer les réponses et le rate limiting
  client.interceptors.response.use(
    (response) => {
      // Logger les informations de rate limiting si disponibles
      const remaining = response.headers['x-shopify-shop-api-call-limit'];
      if (remaining) {
        log.debug('Rate limit Shopify', { limit: remaining });
      }
      return response;
    },
    async (error) => {
      // Gérer le rate limiting (HTTP 429)
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || 2;
        log.warn('Rate limit atteint, pause avant retry', { retryAfter });

        // Attendre et réessayer
        await sleep(retryAfter * 1000);
        return client.request(error.config);
      }

      log.error('Erreur de réponse Shopify', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });

      return Promise.reject(error);
    }
  );

  return client;
}

/**
 * Fonction utilitaire pour pause
 * @param {number} ms - Durée en millisecondes
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Instance du client Shopify
const shopifyClient = createShopifyClient();

/**
 * Met à jour le niveau d'inventaire d'un produit sur Shopify
 *
 * Cette fonction utilise l'endpoint inventory_levels/set pour
 * définir le niveau de stock absolu (pas un ajustement relatif).
 *
 * @param {number} quantity - Nouvelle quantité en stock
 * @param {string} inventoryItemId - ID de l'item d'inventaire (optionnel, utilise config par défaut)
 * @param {string} locationId - ID de l'emplacement (optionnel, utilise config par défaut)
 * @returns {Promise<Object>} Résultat de la mise à jour
 *
 * @example
 * await updateInventoryLevel(100);
 * // Met à jour le stock du produit Hydrofeel à 100 unités
 */
async function updateInventoryLevel(
  quantity,
  inventoryItemId = config.shopify.inventoryItemId,
  locationId = config.shopify.locationId
) {
  log.info('Mise à jour du niveau d\'inventaire Shopify', {
    quantity,
    inventoryItemId,
    locationId,
  });

  // Vérifier que les IDs sont configurés
  if (!inventoryItemId || !locationId) {
    const error = new Error(
      'SHOPIFY_INVENTORY_ITEM_ID et SHOPIFY_LOCATION_ID doivent être configurés'
    );
    log.error('Configuration Shopify incomplète', { error: error.message });
    throw error;
  }

  try {
    // Appel API pour définir le niveau d'inventaire
    const response = await shopifyClient.post('/inventory_levels/set.json', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: quantity,
    });

    log.info('Niveau d\'inventaire mis à jour avec succès', {
      inventoryItemId,
      locationId,
      newQuantity: quantity,
      response: response.data,
    });

    return {
      success: true,
      inventoryLevel: response.data.inventory_level,
    };
  } catch (error) {
    log.error('Erreur lors de la mise à jour de l\'inventaire', {
      error: error.message,
      response: error.response?.data,
    });
    throw error;
  }
}

/**
 * Récupère les informations d'un produit par son ID
 *
 * @param {string} productId - ID du produit Shopify
 * @returns {Promise<Object>} Données du produit
 */
async function getProduct(productId) {
  log.info('Récupération du produit Shopify', { productId });

  try {
    const response = await shopifyClient.get(`/products/${productId}.json`);

    log.debug('Produit récupéré', {
      productId,
      title: response.data.product?.title,
    });

    return response.data.product;
  } catch (error) {
    log.error('Erreur lors de la récupération du produit', {
      productId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère les variants d'un produit
 * Utile pour trouver l'inventory_item_id à partir d'un SKU ou EAN
 *
 * @param {string} productId - ID du produit Shopify
 * @returns {Promise<Array>} Liste des variants
 */
async function getProductVariants(productId) {
  log.info('Récupération des variants du produit', { productId });

  try {
    const response = await shopifyClient.get(`/products/${productId}/variants.json`);

    log.debug('Variants récupérés', {
      productId,
      count: response.data.variants?.length,
    });

    return response.data.variants;
  } catch (error) {
    log.error('Erreur lors de la récupération des variants', {
      productId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère la liste des emplacements (locations) du shop
 * Nécessaire pour connaître le location_id à utiliser
 *
 * @returns {Promise<Array>} Liste des emplacements
 */
async function getLocations() {
  log.info('Récupération des emplacements Shopify');

  try {
    const response = await shopifyClient.get('/locations.json');

    log.debug('Emplacements récupérés', {
      count: response.data.locations?.length,
    });

    return response.data.locations;
  } catch (error) {
    log.error('Erreur lors de la récupération des emplacements', {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère le niveau d'inventaire actuel d'un item
 *
 * @param {string} inventoryItemId - ID de l'item d'inventaire
 * @param {string} locationId - ID de l'emplacement
 * @returns {Promise<Object>} Niveau d'inventaire { available, ... }
 */
async function getInventoryLevel(
  inventoryItemId = config.shopify.inventoryItemId,
  locationId = config.shopify.locationId
) {
  log.info('Récupération du niveau d\'inventaire', {
    inventoryItemId,
    locationId,
  });

  try {
    const response = await shopifyClient.get('/inventory_levels.json', {
      params: {
        inventory_item_ids: inventoryItemId,
        location_ids: locationId,
      },
    });

    const level = response.data.inventory_levels?.[0];

    log.debug('Niveau d\'inventaire récupéré', {
      inventoryItemId,
      available: level?.available,
    });

    return level;
  } catch (error) {
    log.error('Erreur lors de la récupération du niveau d\'inventaire', {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Recherche un produit par son SKU ou code-barres (EAN)
 *
 * @param {string} sku - SKU ou code-barres du produit
 * @returns {Promise<Object|null>} Produit trouvé ou null
 */
async function findProductBySku(sku) {
  log.info('Recherche de produit par SKU', { sku });

  try {
    // L'API Shopify ne permet pas de rechercher directement par SKU
    // On doit récupérer tous les produits et filtrer
    // Pour les grands catalogues, utiliser la GraphQL API serait plus efficace
    const response = await shopifyClient.get('/products.json', {
      params: {
        limit: 250,
        fields: 'id,title,variants',
      },
    });

    // Chercher le produit avec le variant correspondant
    for (const product of response.data.products) {
      for (const variant of product.variants) {
        if (variant.sku === sku || variant.barcode === sku) {
          log.info('Produit trouvé par SKU', {
            sku,
            productId: product.id,
            variantId: variant.id,
            inventoryItemId: variant.inventory_item_id,
          });

          return {
            product,
            variant,
            inventoryItemId: variant.inventory_item_id,
          };
        }
      }
    }

    log.warn('Aucun produit trouvé pour ce SKU', { sku });
    return null;
  } catch (error) {
    log.error('Erreur lors de la recherche par SKU', {
      sku,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Teste la connexion à l'API Shopify
 *
 * @returns {Promise<Object>} Résultat du test { success, shop, message }
 */
async function testConnection() {
  log.info('Test de connexion à l\'API Shopify');

  try {
    const response = await shopifyClient.get('/shop.json');
    const shop = response.data.shop;

    log.info('Connexion Shopify réussie', {
      shopName: shop.name,
      domain: shop.domain,
    });

    return {
      success: true,
      message: 'Connexion à Shopify réussie',
      shop: {
        name: shop.name,
        domain: shop.domain,
        email: shop.email,
        currency: shop.currency,
        timezone: shop.iana_timezone,
      },
    };
  } catch (error) {
    log.error('Échec du test de connexion Shopify', {
      error: error.message,
      status: error.response?.status,
    });

    return {
      success: false,
      message: `Erreur de connexion: ${error.message}`,
      error: error.response?.data,
    };
  }
}

/**
 * Récupère les informations de configuration nécessaires
 * Utile pour aider l'utilisateur à configurer les IDs
 *
 * @returns {Promise<Object>} Informations de configuration
 */
async function getConfigurationInfo() {
  log.info('Récupération des informations de configuration Shopify');

  try {
    const [locations, shopResponse] = await Promise.all([
      getLocations(),
      shopifyClient.get('/shop.json'),
    ]);

    return {
      success: true,
      shop: shopResponse.data.shop.name,
      locations: locations.map((loc) => ({
        id: loc.id,
        name: loc.name,
        active: loc.active,
      })),
      instructions: [
        '1. Notez le location_id de votre emplacement principal',
        '2. Pour trouver l\'inventory_item_id, utilisez findProductBySku(ean)',
        '3. Configurez SHOPIFY_LOCATION_ID et SHOPIFY_INVENTORY_ITEM_ID dans .env',
      ],
    };
  } catch (error) {
    log.error('Erreur lors de la récupération des infos de configuration', {
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  updateInventoryLevel,
  getProduct,
  getProductVariants,
  getLocations,
  getInventoryLevel,
  findProductBySku,
  testConnection,
  getConfigurationInfo,
};
