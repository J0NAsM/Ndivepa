/**
 * Conjunto de datos de demostración del dominio afiliado.
 *
 * Existe por una razón concreta: la semilla por módulo solo crea los datos
 * *base* (monedas, países, roles, categorías, facetas). Sin catálogo afiliado el
 * panel arranca vacío, el dashboard no tiene embudo y `/producto/...`,
 * `/campana/...` y `/go/:linkId` no tienen nada que mostrar.
 *
 * Tres reglas que este fichero respeta a propósito:
 *
 *  1. **Pasa por los servicios de dominio, nunca por el documento.** Un producto
 *     afiliado se crea en borrador, recibe su enlace y solo entonces se publica,
 *     de modo que `assertPublishable` valida la demo igual que valida al panel.
 *     Así la demo no puede contener datos que el dominio rechazaría.
 *  2. **Es idempotente.** Si ya hay productos, no hace nada. Arrancar diez veces
 *     no duplica ni infla las métricas.
 *  3. **No se activa en producción.** Se controla con `SEED_DEMO`, cuyo valor por
 *     defecto es `false` cuando `NODE_ENV=production`. Una instalación real no
 *     recibe productos de ejemplo.
 *
 * Los enlaces apuntan a rutas de comercio con el parámetro de tracking que exige
 * cada programa, para que la validación local los marque `valid` sin inventar
 * ninguna credencial: los identificadores de afiliado son ficticios y están
 * marcados como tales.
 */

const DEMO_NETWORKS = [
  {
    id: 'net-amazon',
    name: 'Amazon Associates',
    status: 'active',
    website: 'https://affiliate-program.amazon.com',
    allowedTracking: { subId: true, sharedId: false, utm: false, redirect: false, deepLinks: true },
    cookieWindowDays: 1,
    payoutTermsDays: 60,
    notes: 'Red de demostración. La cuenta real requiere aprobación del programa.',
  },
  {
    id: 'net-impact',
    name: 'Impact',
    status: 'active',
    website: 'https://impact.com',
    allowedTracking: { subId: true, sharedId: true, utm: true, redirect: true, deepLinks: true },
    cookieWindowDays: 30,
    payoutTermsDays: 45,
    notes: 'Red de demostración.',
  },
  {
    id: 'net-hotmart',
    name: 'Hotmart',
    status: 'active',
    website: 'https://hotmart.com',
    allowedTracking: { subId: true, sharedId: false, utm: false, redirect: false, deepLinks: true },
    cookieWindowDays: 90,
    payoutTermsDays: 30,
    notes: 'Red de demostración.',
  },
];

const DEMO_MERCHANTS = [
  {
    id: 'mer-amazon',
    name: 'Amazon',
    domains: ['amazon.com', 'amazon.es'],
    status: 'active',
    website: 'https://www.amazon.com',
    notes: 'Comercio de demostración con dos dominios para probar la coincidencia por sufijo.',
  },
  {
    id: 'mer-udemy',
    name: 'Udemy',
    domains: ['udemy.com'],
    status: 'active',
    website: 'https://www.udemy.com',
    notes: 'Comercio de demostración de formación online.',
  },
  {
    id: 'mer-hotmart',
    name: 'Hotmart',
    domains: ['hotmart.com'],
    status: 'active',
    website: 'https://hotmart.com',
    notes: 'Comercio de demostración de productos digitales.',
  },
];

const DEMO_PROGRAMS = [
  {
    id: 'prog-amazon',
    name: 'Amazon Associates · Tecnología',
    networkId: 'net-amazon',
    merchantId: 'mer-amazon',
    affiliateId: 'ndivepa-demo',
    trackingId: 'ndivepademo-20',
    requiredTrackingKey: 'tag',
    commissionType: 'percentage',
    estimatedCommission: 3,
    commissionCurrency: 'USD',
    priority: 10,
    status: 'active',
    termsUrl: 'https://affiliate-program.amazon.com/help/operating/policies',
    notes: 'Identificador de demostración: sustitúyelo por tu tag real antes de publicar.',
  },
  {
    id: 'prog-udemy',
    name: 'Udemy · Cursos',
    networkId: 'net-impact',
    merchantId: 'mer-udemy',
    affiliateId: 'ndivepa-demo',
    trackingId: 'NDIVEPADEMO',
    requiredTrackingKey: 'referralCode',
    commissionType: 'percentage',
    estimatedCommission: 10,
    commissionCurrency: 'USD',
    priority: 20,
    status: 'active',
    notes: 'Identificador de demostración.',
  },
  {
    id: 'prog-hotmart',
    name: 'Hotmart · Productos digitales',
    networkId: 'net-hotmart',
    merchantId: 'mer-hotmart',
    affiliateId: 'ndivepa-demo',
    trackingId: 'ndivepademo',
    requiredTrackingKey: 'src',
    // Tramos: cuanto mayor el importe, mayor el porcentaje acordado.
    commissionType: 'tiered',
    estimatedCommission: 0,
    commissionCurrency: 'USD',
    commissionTiers: [
      { minAmount: 0, percent: 20 },
      { minAmount: 10_000, percent: 30 },
      { minAmount: 50_000, percent: 40 },
    ],
    priority: 30,
    status: 'active',
    notes: 'Identificador de demostración.',
  },
];

// Los identificadores coinciden con los que envía `public/app.js` en el parámetro
// `placement` de `/go/:linkId`. Si no coincidieran, el informe por ubicación
// mostraría clics atribuidos a ubicaciones que no existen en el catálogo.
const DEMO_PLACEMENTS = [
  { id: 'plc-home', name: 'Portada', key: 'portada', description: 'Rejilla principal del sitio público.' },
  { id: 'plc-featured', name: 'Ficha de producto', key: 'ficha-producto', description: 'Botón de oferta de la ficha.' },
  { id: 'plc-guide', name: 'Guía editorial', key: 'guia', description: 'Enlaces dentro de guías y comparativas.' },
];

const DEMO_CAMPAIGNS = [
  {
    id: 'camp-tec-2026',
    name: 'Tecnología para trabajar mejor',
    code: 'TEC-2026',
    channel: 'organico',
    objective: 'Seleccionar equipo de trabajo remoto con enlaces verificados y precio comprobado.',
    audience: 'Profesionales que trabajan desde casa.',
    status: 'active',
  },
  {
    id: 'camp-form-2026',
    name: 'Formación continua',
    code: 'FORM-2026',
    channel: 'boletin',
    objective: 'Recomendar formación online con comisión por venta.',
    audience: 'Perfiles técnicos en reconversión.',
    status: 'active',
  },
];

/**
 * Productos de demostración.
 *
 * `links` describe los enlaces que se crean después, en borrador, para poder
 * publicar el producto solo cuando tiene un enlace aceptable.
 */
const DEMO_PRODUCTS = [
  {
    handle: 'notebook-trabajo-remoto',
    name: 'Notebook para trabajo remoto',
    subtitle: 'Equilibrio entre autonomía, peso y potencia para jornadas completas.',
    description: 'Selección para quien trabaja fuera de la oficina: pantalla mate, teclado cómodo y '
      + 'autonomía suficiente para una jornada sin cargador. La compra se realiza en el comercio, '
      + 'que fija el precio final y las condiciones de envío.',
    shortDescription: 'Portátil de trabajo con autonomía de jornada completa.',
    type: 'physical',
    brand: 'Genérica',
    categoryId: 'pcat_tech_laptops',
    categoryIds: ['pcat_tech', 'pcat_tech_laptops'],
    tagIds: ['tag_recomendado'],
    collectionIds: ['pcol_destacados', 'pcol_tech'],
    campaignId: 'camp-tec-2026',
    merchantId: 'mer-amazon',
    programId: 'prog-amazon',
    image: '💻',
    featured: true,
    featuredRank: 10,
    price: { amount: 89_900, currency: 'USD', source: 'manual' },
    seo: { description: 'Comparativa breve de un portátil pensado para trabajo remoto.' },
    links: [
      {
        label: 'Amazon · ficha principal',
        affiliateUrl: 'https://www.amazon.com/dp/B0DEMO0001?tag=ndivepademo-20',
        productUrl: 'https://www.amazon.com/dp/B0DEMO0001',
        merchantId: 'mer-amazon',
        programId: 'prog-amazon',
        priority: 10,
        merchantPrice: { amount: 89_900, currency: 'USD', source: 'manual' },
      },
      {
        label: 'Amazon España · mismo modelo',
        affiliateUrl: 'https://www.amazon.es/dp/B0DEMO0001?tag=ndivepademo-20',
        productUrl: 'https://www.amazon.es/dp/B0DEMO0001',
        merchantId: 'mer-amazon',
        programId: 'prog-amazon',
        priority: 20,
        merchantPrice: { amount: 94_500, currency: 'USD', source: 'manual' },
      },
    ],
  },
  {
    handle: 'auriculares-cancelacion-ruido',
    name: 'Auriculares con cancelación de ruido',
    subtitle: 'Para reuniones y espacios compartidos.',
    description: 'Cancelación activa suficiente para trabajar en un espacio compartido, con micrófono '
      + 'usable en videollamadas. El precio y el stock los define el comercio.',
    shortDescription: 'Cancelación activa y micrófono para videollamadas.',
    type: 'physical',
    brand: 'Genérica',
    categoryId: 'pcat_tech_audio',
    categoryIds: ['pcat_tech', 'pcat_tech_audio'],
    tagIds: ['tag_oferta'],
    collectionIds: ['pcol_tech'],
    campaignId: 'camp-tec-2026',
    merchantId: 'mer-amazon',
    programId: 'prog-amazon',
    image: '🎧',
    price: { amount: 24_900, previousAmount: 29_900, currency: 'USD', source: 'manual' },
    links: [
      {
        label: 'Amazon · auriculares',
        affiliateUrl: 'https://www.amazon.com/dp/B0DEMO0002?tag=ndivepademo-20',
        productUrl: 'https://www.amazon.com/dp/B0DEMO0002',
        merchantId: 'mer-amazon',
        programId: 'prog-amazon',
        priority: 10,
        merchantPrice: { amount: 24_900, currency: 'USD', source: 'manual' },
        coupon: { code: 'DEMO10', description: 'Cupón de demostración publicado por el comercio.', source: 'comercio' },
      },
    ],
  },
  {
    handle: 'curso-analisis-de-datos',
    name: 'Curso de análisis de datos',
    subtitle: 'Ruta completa de SQL a visualización.',
    description: 'Formación online con ejercicios evaluados. La matrícula se gestiona en la plataforma '
      + 'del comercio, que emite la factura y aplica su propia política de devolución.',
    shortDescription: 'Formación online de análisis de datos con ejercicios evaluados.',
    type: 'digital',
    categoryId: 'pcat_edu_courses',
    categoryIds: ['pcat_education', 'pcat_edu_courses'],
    tagIds: ['tag_novedad'],
    campaignId: 'camp-form-2026',
    merchantId: 'mer-udemy',
    programId: 'prog-udemy',
    image: '📊',
    price: { amount: 4_990, currency: 'USD', source: 'manual' },
    links: [
      {
        label: 'Udemy · curso de datos',
        affiliateUrl: 'https://www.udemy.com/course/analisis-de-datos-demo/?referralCode=NDIVEPADEMO',
        productUrl: 'https://www.udemy.com/course/analisis-de-datos-demo/',
        merchantId: 'mer-udemy',
        programId: 'prog-udemy',
        priority: 10,
        merchantPrice: { amount: 4_990, currency: 'USD', source: 'manual' },
      },
    ],
  },
  {
    handle: 'plantillas-productividad',
    name: 'Pack de plantillas de productividad',
    subtitle: 'Sistema de planificación semanal listo para usar.',
    description: 'Producto digital descargable con plantillas de planificación. La entrega y el soporte '
      + 'corren por cuenta del comercio.',
    shortDescription: 'Plantillas descargables de planificación semanal.',
    type: 'digital',
    categoryId: 'pcat_software',
    categoryIds: ['pcat_software'],
    merchantId: 'mer-hotmart',
    programId: 'prog-hotmart',
    image: '🗂️',
    price: { amount: 2_700, currency: 'USD', source: 'manual' },
    links: [
      {
        label: 'Hotmart · pack de plantillas',
        affiliateUrl: 'https://pay.hotmart.com/DEMO0004?off=demo0004&src=ndivepademo',
        productUrl: 'https://pay.hotmart.com/DEMO0004',
        merchantId: 'mer-hotmart',
        programId: 'prog-hotmart',
        priority: 10,
        merchantPrice: { amount: 2_700, currency: 'USD', source: 'manual' },
      },
    ],
  },
];

/** Recorrido de demostración: vistas, clics y una conversión aprobada por producto guía. */
const DEMO_JOURNEY = [
  { handle: 'notebook-trabajo-remoto', views: 6, clicks: 3, conversion: { saleAmount: 89_900, approve: true } },
  { handle: 'auriculares-cancelacion-ruido', views: 5, clicks: 2, conversion: { saleAmount: 24_900, approve: false } },
  { handle: 'curso-analisis-de-datos', views: 4, clicks: 2, conversion: null },
  { handle: 'plantillas-productividad', views: 2, clicks: 1, conversion: null },
];

const withVerifiedPrice = (price, timestamp) => (price ? { ...price, verifiedAt: timestamp } : price);

/**
 * Siembra el catálogo afiliado de demostración.
 *
 * @param {object} container contenedor ya arrancado
 * @param {object} logger
 * @returns {Promise<{seeded:boolean, products?:number, links?:number, reason?:string}>}
 */
export async function seedDemoCatalog(container, logger) {
  const catalog = container.resolve('catalog');
  const affiliate = container.resolve('affiliate');
  const analytics = container.resolve('analytics');

  // Idempotencia: la demo solo puebla un catálogo vacío. Si el operador ya creó
  // productos —propios o importados—, no se toca nada.
  if (catalog.products.repository.count() > 0) {
    return { seeded: false, reason: 'el catálogo ya tiene productos' };
  }

  await affiliate.networks.seed(DEMO_NETWORKS, 'id');
  await affiliate.merchants.seed(DEMO_MERCHANTS, 'id');
  await affiliate.programs.seed(DEMO_PROGRAMS, 'id');
  await affiliate.placements.seed(DEMO_PLACEMENTS, 'id');
  await affiliate.campaigns.seed(DEMO_CAMPAIGNS, 'id');

  const verifiedAt = new Date().toISOString();
  const byHandle = new Map();
  let linkCount = 0;

  for (const definition of DEMO_PRODUCTS) {
    const { links = [], ...fields } = definition;

    // Borrador primero: un producto afiliado no se puede publicar sin enlace
    // aceptable, y la demo no es una excepción a esa regla.
    const product = await catalog.products.create({ ...fields, status: 'draft' });

    for (const link of links) {
      await affiliate.links.create({
        ...link,
        productId: product.id,
        merchantPrice: withVerifiedPrice(link.merchantPrice, verifiedAt),
        coupon: link.coupon ? { ...link.coupon, seenAt: verifiedAt } : undefined,
      });
      linkCount += 1;
    }

    const published = await catalog.products.update(product.id, { status: 'published' });
    byHandle.set(definition.handle, published);
  }

  const journey = await seedDemoJourney({ analytics, affiliate, byHandle });

  logger?.info('Catálogo de demostración creado', {
    products: byHandle.size,
    links: linkCount,
    clicks: journey.clicks,
    conversions: journey.conversions,
  });

  return { seeded: true, products: byHandle.size, links: linkCount, ...journey };
}

/**
 * Vistas, clics y conversiones de ejemplo para que el dashboard tenga embudo real.
 *
 * Los clics se registran con `consent: true` y con una sesión distinta cada vez:
 * repetir sesión y producto en menos de 2,5 s activaría el marcador de fraude y
 * la demo empezaría con una alerta falsa.
 */
async function seedDemoJourney({ analytics, affiliate, byHandle }) {
  const report = { views: 0, clicks: 0, conversions: 0, commissions: 0 };

  for (const step of DEMO_JOURNEY) {
    const product = byHandle.get(step.handle);
    if (!product) continue;
    const links = affiliate.links.forProduct(product.id);
    const link = links.find(item => item.status === 'valid') || links[0];
    if (!link) continue;

    for (let index = 0; index < step.views; index += 1) {
      await analytics.tracking.trackView({
        productId: product.id,
        sessionId: `demo-${step.handle}-v${index}`,
        source: 'organic',
        page: `/producto/${product.handle}`,
        consent: true,
      });
      report.views += 1;
    }

    const clickIds = [];
    for (let index = 0; index < step.clicks; index += 1) {
      const result = await analytics.tracking.registerClick({
        linkId: link.id,
        sessionId: `demo-${step.handle}-c${index}`,
        source: 'organic',
        placementId: 'plc-featured',
        page: `/producto/${product.handle}`,
        consent: true,
      });
      if (result?.clickId) clickIds.push(result.clickId);
      report.clicks += 1;
    }

    if (!step.conversion || !clickIds.length) continue;

    const conversion = await affiliate.conversions.create({
      networkConversionId: `DEMO-${step.handle.toUpperCase().slice(0, 12)}`,
      clickId: clickIds[0],
      productId: product.id,
      merchantId: link.merchantId,
      programId: link.programId,
      type: product.type === 'digital' ? 'subscription' : 'purchase',
      saleAmount: step.conversion.saleAmount,
      saleCurrency: 'USD',
      source: 'manual',
    });
    report.conversions += 1;

    // Aprobar es el único camino por el que nace una comisión. Una conversión
    // pendiente se queda pendiente: no es ingreso y la demo no finge que lo sea.
    if (step.conversion.approve) {
      await affiliate.conversions.approve(conversion.id);
      report.commissions += 1;
    }
  }

  return report;
}

export const DEMO_DATASET = {
  networks: DEMO_NETWORKS,
  merchants: DEMO_MERCHANTS,
  programs: DEMO_PROGRAMS,
  placements: DEMO_PLACEMENTS,
  campaigns: DEMO_CAMPAIGNS,
  products: DEMO_PRODUCTS,
  journey: DEMO_JOURNEY,
};
