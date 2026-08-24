/**
 * Migraciones de esquema (M-0058 … M-0060, M-0164 … M-0172, M-1012).
 *
 * El monolito hacía esto al arrancar:
 *
 *     if (data.schema !== 'affiliate-v1') { const users = data.users; data = seed; data.users = users }
 *
 * Es decir: **descartaba todo el catálogo** ante cualquier cambio de esquema. Aquí no
 * se descarta nada. Cada migración transforma de `n` a `n+1` y el `Store` guarda un
 * snapshot antes de aplicarlas.
 */
import { toMinor } from './framework/money.js';
import { slug } from './framework/strings.js';
import { now } from './framework/dates.js';

/** Colecciones que la v0.2 espera encontrar en el documento. */
export const COLLECTIONS = [
  'currencies', 'settingEntries', 'countries', 'provinces', 'zones', 'regions',
  'taxCategories', 'taxRates', 'channels', 'sellers', 'roles', 'users', 'invites',
  'apiKeys', 'sessions', 'customerSessions', 'customerGroups', 'addresses', 'customers', 'assets', 'tags',
  'categories', 'collections', 'facets', 'facetValues', 'productOptions', 'variants',
  'products', 'prices', 'priceLists', 'stockLocations', 'inventoryItems',
  'inventoryLevels', 'reservations', 'stockMovements', 'carts', 'orders',
  'historyEntries', 'returnReasons', 'returns', 'exchanges', 'claims', 'refunds',
  'draftOrders', 'paymentMethods', 'paymentCollections', 'paymentSessions', 'payments',
  'shippingProfiles', 'fulfillmentSets', 'serviceZones', 'shippingOptions',
  'fulfillments', 'promotionCampaigns', 'promotions', 'coupons', 'promotionUsages',
  'giftCards', 'contents', 'merchants', 'networks', 'programs', 'placements',
  'campaigns', 'affiliateLinks', 'conversions', 'commissions', 'payouts', 'alerts',
  'loyaltyPrograms', 'loyaltyAccounts', 'loyaltyTransactions',
  'audits', 'events', 'notifications', 'translations', 'jobs', 'webhooks',
  'webhookDeliveries', 'workflowRuns', 'imports',
];

/**
 * v1 -> v2: del esquema `affiliate-v1` al modelo modular.
 *
 * Lo que hace, por orden:
 *  1. Crea las colecciones que faltan, vacías.
 *  2. Normaliza `settings`: `currency` -> `currencies[]` + `defaultCurrency`.
 *  3. Da `handle`, `path` y `depth` a las categorías planas.
 *  4. Convierte `affiliateProducts` en `products` **con variante implícita**.
 *  5. Pasa los importes de precio, conversión y comisión a **unidades mínimas**.
 *  6. Da a los enlaces su `merchantId`/`programId` y su estado de revisión.
 *  7. Convierte el `role: 'admin'` heredado en `roleCodes: ['superadmin']`.
 *  8. Conserva `affiliateProducts` como espejo de solo lectura para la SPA v0.1.
 */
function migrateV1toV2(state) {
  const data = { ...state };

  for (const collection of COLLECTIONS) {
    if (!Array.isArray(data[collection])) data[collection] = [];
  }

  // --- Ajustes ---------------------------------------------------------------
  const legacySettings = data.settings || {};
  const legacyCurrency = String(legacySettings.currency || 'USD').toUpperCase();
  data.settings = {
    ...legacySettings,
    defaultCurrency: legacySettings.defaultCurrency || legacyCurrency,
    currencies: legacySettings.currencies || [legacyCurrency],
    locales: legacySettings.locales || ['es'],
    defaultLocale: legacySettings.defaultLocale || 'es',
    // El modo afiliado se conserva: migrar no puede activar el comercio directo.
    commerceMode: legacySettings.commerceMode || 'AFFILIATE',
    migratedAt: now(),
  };

  // --- Categorías ------------------------------------------------------------
  const usedHandles = new Set();
  data.categories = (data.categories || []).map((category, index) => {
    let handle = category.handle || slug(category.name || `categoria-${index + 1}`);
    while (usedHandles.has(handle)) handle = `${handle}-${index + 1}`;
    usedHandles.add(handle);
    return {
      ...category,
      handle,
      path: category.path || `/${handle}`,
      depth: category.depth ?? 0,
      rank: category.rank ?? (index + 1) * 10,
      visible: category.visible ?? true,
      internal: category.internal ?? false,
      parentId: category.parentId ?? null,
      createdAt: category.createdAt || now(),
      updatedAt: now(),
      deletedAt: null,
    };
  });

  // --- Productos y variantes -------------------------------------------------
  const legacyProducts = data.affiliateProducts || [];
  const productHandles = new Set();
  const migratedProducts = [];
  const migratedVariants = [];
  const migratedPrices = [];

  for (const legacy of legacyProducts) {
    let handle = slug(legacy.name || legacy.id);
    while (productHandles.has(handle)) handle = `${handle}-${legacy.id.slice(-4)}`;
    productHandles.add(handle);

    const currency = String(legacy.price?.currency || legacyCurrency).toUpperCase();
    // Los importes de la v0.1 eran decimales; ahora se guardan en unidades mínimas.
    const amount = legacy.price?.amount === null || legacy.price?.amount === undefined
      ? null
      : toMinor(legacy.price.amount, currency);
    const previousAmount = legacy.price?.previousAmount === null || legacy.price?.previousAmount === undefined
      ? null
      : toMinor(legacy.price.previousAmount, currency);

    const product = {
      id: legacy.id,
      name: legacy.name,
      handle,
      handleHistory: [],
      subtitle: null,
      description: legacy.description || '',
      shortDescription: null,
      status: legacy.status === 'published' ? 'published' : 'draft',
      type: legacy.type && ['physical', 'digital', 'service', 'course', 'bundle', 'subscription'].includes(legacy.type)
        ? legacy.type
        : 'other',
      monetizationType: 'AFFILIATE',
      monetizationPriority: 'affiliate',
      brand: null,
      manufacturer: null,
      categoryId: legacy.categoryId || null,
      categoryIds: legacy.categoryId ? [legacy.categoryId] : [],
      collectionIds: [],
      tagIds: [],
      facetValueIds: [],
      channelIds: [],
      assetIds: [],
      primaryAssetId: null,
      image: legacy.image || null,
      shippingProfileId: null,
      taxCategoryId: null,
      relatedProductIds: [],
      alternativeProductIds: [],
      accessoryProductIds: [],
      featured: false,
      featuredRank: 0,
      seo: {},
      merchantId: legacy.merchantId || null,
      programId: legacy.programId || null,
      campaignId: legacy.campaignId || null,
      price: {
        amount,
        previousAmount,
        currency,
        source: legacy.price?.source || 'unknown',
        updatedAt: legacy.price?.updatedAt || null,
      },
      viewCount: 0,
      clickCount: 0,
      publishedAt: legacy.status === 'published' ? legacy.createdAt || now() : null,
      metadata: legacy.metadata || {},
      createdAt: legacy.createdAt || now(),
      updatedAt: now(),
      deletedAt: null,
    };
    migratedProducts.push(product);

    // Variante implícita: la v0.1 no tenía variantes, pero el modelo nuevo las exige
    // para poder vender directo el día que se active ese modo.
    const variantId = `var_${legacy.id}`;
    migratedVariants.push({
      id: variantId,
      productId: legacy.id,
      title: 'Estándar',
      sku: null,
      optionValues: {},
      assetIds: [],
      // El producto afiliado no gestiona stock propio: lo vende el comercio externo.
      manageInventory: false,
      allowBackorder: false,
      components: [],
      rank: 0,
      isDefault: true,
      active: true,
      dimensionUnit: 'cm',
      weightUnit: 'g',
      metadata: { migratedFrom: 'affiliate-v1' },
      createdAt: product.createdAt,
      updatedAt: now(),
      deletedAt: null,
    });

    if (amount !== null) {
      migratedPrices.push({
        id: `price_${legacy.id}`,
        variantId,
        currencyCode: currency,
        amount,
        compareAtAmount: previousAmount,
        minQuantity: 1,
        includesTax: false,
        active: true,
        metadata: { migratedFrom: 'affiliate-v1' },
        createdAt: product.createdAt,
        updatedAt: now(),
        deletedAt: null,
      });
    }
  }

  data.products = [...migratedProducts, ...(data.products || [])];
  data.variants = [...migratedVariants, ...(data.variants || [])];
  data.prices = [...migratedPrices, ...(data.prices || [])];

  // --- Enlaces afiliados -----------------------------------------------------
  const productsById = new Map(migratedProducts.map(product => [product.id, product]));
  data.affiliateLinks = (data.affiliateLinks || []).map(link => {
    const product = productsById.get(link.productId);
    return {
      ...link,
      merchantId: link.merchantId || product?.merchantId || null,
      programId: link.programId || product?.programId || null,
      label: link.label || null,
      priority: link.priority ?? 100,
      merchantPrice: link.merchantPrice || {
        amount: product?.price?.amount ?? null,
        currency: product?.price?.currency || legacyCurrency,
        verifiedAt: product?.price?.updatedAt || null,
        source: product?.price?.source === 'unknown' ? 'manual' : product?.price?.source || 'manual',
      },
      priceHistory: link.priceHistory || [],
      coupon: link.coupon || null,
      reviewState: link.status === 'valid' ? 'done' : 'queued',
      reviewAssignee: null,
      active: link.active ?? true,
      metadata: link.metadata || {},
      createdAt: link.createdAt || now(),
      updatedAt: now(),
      deletedAt: null,
    };
  });

  // --- Conversiones y comisiones en unidades mínimas -------------------------
  data.conversions = (data.conversions || []).map(conversion => {
    const saleCurrency = String(conversion.saleCurrency || legacyCurrency).toUpperCase();
    const commissionCurrency = String(conversion.commissionCurrency || legacyCurrency).toUpperCase();
    return {
      ...conversion,
      saleAmount: conversion.saleAmount === null || conversion.saleAmount === undefined
        ? null
        : toMinor(conversion.saleAmount, saleCurrency),
      saleCurrency,
      commission: conversion.commission === null || conversion.commission === undefined
        ? null
        : toMinor(conversion.commission, commissionCurrency),
      commissionCurrency,
      programId: conversion.programId || productsById.get(conversion.productId)?.programId || null,
      attribution: conversion.attribution || null,
      createdAt: conversion.createdAt || conversion.date || now(),
      updatedAt: now(),
      deletedAt: null,
    };
  });

  data.commissions = (data.commissions || []).map(commission => {
    const currency = String(commission.currency || legacyCurrency).toUpperCase();
    return {
      ...commission,
      amount: commission.amount === null || commission.amount === undefined ? 0 : toMinor(commission.amount, currency),
      currency,
      programId: commission.programId || productsById.get(commission.productId)?.programId || null,
      approvedAt: commission.approvedAt || null,
      payoutId: commission.payoutId || null,
      createdAt: commission.createdAt || now(),
      updatedAt: now(),
      deletedAt: null,
    };
  });

  data.payouts = (data.payouts || []).map(payout => {
    const currency = String(payout.currency || legacyCurrency).toUpperCase();
    return {
      ...payout,
      amount: payout.amount === null || payout.amount === undefined ? 0 : toMinor(payout.amount, currency),
      currency,
      commissionIds: payout.commissionIds || [],
      createdAt: payout.createdAt || now(),
      updatedAt: now(),
      deletedAt: null,
    };
  });

  // --- Usuarios y roles ------------------------------------------------------
  data.users = (data.users || []).map(user => ({
    ...user,
    // `role: 'admin'` de la v0.1 equivale a superadministración.
    roleCodes: user.roleCodes || (user.role === 'admin' ? ['superadmin'] : []),
    channelScope: user.channelScope || [],
    locale: user.locale || 'es',
    status: user.status || 'active',
    failedLogins: user.failedLogins ?? 0,
    lockedUntil: user.lockedUntil ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    twoFactor: user.twoFactor || { enabled: false, secret: null, backupCodes: [], confirmedAt: null },
    createdAt: user.createdAt || now(),
    updatedAt: now(),
    deletedAt: null,
  }));

  // --- Resto de colecciones heredadas: marcas de tiempo y borrado lógico ------
  for (const collection of ['merchants', 'networks', 'programs', 'placements', 'campaigns', 'alerts']) {
    data[collection] = (data[collection] || []).map(row => ({
      ...row,
      createdAt: row.createdAt || now(),
      updatedAt: now(),
      deletedAt: null,
      metadata: row.metadata || {},
    }));
  }

  data.alerts = data.alerts.map(alert => ({
    ...alert,
    occurrences: alert.occurrences ?? 1,
    lastSeenAt: alert.lastSeenAt || alert.createdAt || now(),
    entityType: alert.entityType || null,
    resolvedAt: alert.resolvedAt || null,
    resolvedBy: alert.resolvedBy || null,
    resolutionNote: alert.resolutionNote || null,
  }));

  data.programs = data.programs.map(program => ({
    ...program,
    commissionTiers: program.commissionTiers || [],
    priority: program.priority ?? 100,
  }));

  // Los eventos conservan su forma: son un registro histórico y reescribirlos
  // falsearía la analítica.
  data.events = (data.events || []).map(event => ({ ...event, fraudFlag: event.fraudFlag ?? false }));

  // `affiliateProducts` se conserva como espejo de compatibilidad para la SPA v0.1.
  data.affiliateProducts = legacyProducts;
  delete data.schema;

  return data;
}

/** Migración 2 -> 3: reserva para el siguiente cambio de esquema. */
function migrateV2toV3(state) {
  const data = { ...state };
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(data[collection])) data[collection] = [];
  }
  return data;
}

/**
 * Registra todas las migraciones en el store.
 * @param {import('./framework/store.js').Store} store
 */
export function registerMigrations(store) {
  store.migration({
    from: 0,
    to: 1,
    description: 'Documento inicial vacío con las colecciones declaradas.',
    up: state => {
      const data = { ...state };
      for (const collection of COLLECTIONS) {
        if (!Array.isArray(data[collection])) data[collection] = [];
      }
      if (!data.settings) data.settings = {};
      return data;
    },
  });

  store.migration({
    from: 1,
    to: 2,
    description: 'affiliate-v1 -> modelo modular: productos con variante, importes en unidades mínimas, roles.',
    up: migrateV1toV2,
  });

  store.migration({
    from: 2,
    to: 3,
    description: 'Asegura las colecciones nuevas sin tocar los datos existentes.',
    up: migrateV2toV3,
  });

  return store;
}

/**
 * Detecta un documento de la v0.1 para asignarle la versión de partida correcta.
 * Sin esto, un `data/db.json` heredado se trataría como versión 0 y la migración
 * v1->v2 no se aplicaría a sus datos.
 */
export function detectLegacyVersion(document) {
  if (!document) return 0;
  if (typeof document.schemaVersion === 'number') return document.schemaVersion;
  if (document.schema === 'affiliate-v1') return 1;
  if (Array.isArray(document.affiliateProducts) && document.affiliateProducts.length) return 1;
  return 0;
}
