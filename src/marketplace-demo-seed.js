/**
 * Datos de demostración del marketplace (solo con `SEED_DEMO`, nunca en producción).
 *
 * Igual que `demo-seed.js`, pasa por los servicios de dominio: la tienda se
 * aprueba con el mismo flujo que usa administración y cada producto se publica
 * pasando `assertPublishable`. Es idempotente: si ya existe una tienda marcada
 * como demo no hace nada.
 *
 * Todo lo sembrado está marcado como demostración (`metadata.demo`, textos
 * «tienda de demostración»). Las tarifas y precios son de ejemplo. Las cuentas
 * de demostración usan `DEMO_ACCOUNT_PASSWORD` o, si falta, una contraseña de
 * desarrollo documentada en `.env.example`; en producción esta semilla no corre.
 */
const DEMO_PASSWORD_FALLBACK = 'Demo-Ndivepa-2026!';

const STORES = [
  {
    code: 'hamacas-del-centro-demo',
    name: 'Hamacas del Centro (demo)',
    type: 'artisan',
    tagline: 'Hamacas y tejidos de poyvi hechos a mano.',
    description: 'Tienda de demostración. Taller familiar de hamacas y mantas tejidas en poyvi con telares tradicionales.',
    categories: ['poyvi', 'artesania'],
    area: 'Centro',
    public: true,
    lat: -25.7672,
    lng: -57.2338,
    delivery: ['pickup', 'local_delivery', 'national_shipping'],
    owner: { email: 'hamacas@demo.ndivepa.local', firstName: 'Rosa', lastName: 'Benítez' },
    products: [
      { name: 'Hamaca de poyvi doble', category: 'poyvi', price: 450000, compareAt: 520000, stock: 6, tags: ['hamaca', 'poyvi', 'artesanal'], emoji: '🧶', description: 'Hamaca doble tejida a mano en poyvi de algodón. Soporta hasta 150 kg. Incluye cuerdas de colgado.' },
      { name: 'Hamaca de poyvi individual', category: 'poyvi', price: 290000, stock: 10, tags: ['hamaca', 'poyvi'], emoji: '🧶', description: 'Hamaca individual en poyvi, colores naturales. Ideal para galerías y patios.' },
      { name: 'Manta de poyvi para sofá', category: 'textiles', price: 180000, stock: 8, tags: ['manta', 'poyvi', 'hogar'], emoji: '🛋️', description: 'Manta liviana tejida en poyvi, 1,40 × 2 m.' },
    ],
  },
  {
    code: 'sabores-de-carapegua-demo',
    name: 'Sabores de Carapeguá (demo)',
    type: 'entrepreneur',
    tagline: 'Chipa, mbeju y dulces caseros.',
    description: 'Tienda de demostración. Emprendimiento de gastronomía típica con pedidos para el día y retiro en el local.',
    categories: ['gastronomia'],
    area: 'Zona urbana',
    public: false,
    delivery: ['pickup', 'local_delivery'],
    owner: { email: 'sabores@demo.ndivepa.local', firstName: 'Marta', lastName: 'Ortiz' },
    products: [
      { name: 'Chipa casera por docena', category: 'gastronomia', price: 25000, stock: 40, tags: ['chipa', 'típico'], emoji: '🥯', description: 'Docena de chipa horneada en tatakua. Pedidos con un día de anticipación.' },
      { name: 'Dulce de mamón en frasco', category: 'gastronomia', price: 30000, compareAt: 35000, stock: 15, tags: ['dulce', 'casero'], emoji: '🍯', description: 'Frasco de 500 g de dulce de mamón artesanal.' },
    ],
  },
  {
    code: 'moda-local-demo',
    name: 'Moda Local (demo)',
    type: 'commerce',
    tagline: 'Ropa y accesorios con ao poʼi.',
    description: 'Tienda de demostración. Comercio de ropa y accesorios con bordados tradicionales y diseño actual.',
    categories: ['moda', 'accesorios'],
    area: 'Centro',
    public: true,
    lat: -25.7661,
    lng: -57.2319,
    delivery: ['pickup', 'national_shipping'],
    owner: { email: 'moda@demo.ndivepa.local', firstName: 'Lucía', lastName: 'Giménez' },
    products: [
      { name: 'Camisa de ao poi bordada', category: 'ropa', price: 210000, stock: 5, tags: ['ao poi', 'camisa', 'bordado'], emoji: '👕', description: 'Camisa de ao poʼi con bordado a mano. Talles S a XL.' },
      { name: 'Bolso tejido de mano', category: 'accesorios', price: 95000, stock: 12, tags: ['bolso', 'tejido'], emoji: '👜', description: 'Bolso de fibra tejida con forro interior y cierre.' },
    ],
  },
];

export async function seedMarketplaceDemo(container, logger) {
  const channel = container.resolve('channel');
  if (channel.sellers.repository.all().some(seller => seller.metadata?.demo)) return { seeded: false, reason: 'ya existe' };

  const settings = container.resolve('settings').settings;
  const customers = container.resolve('customer').customers;
  const mp = container.resolve('marketplace');
  const catalog = container.resolve('catalog');
  const password = process.env.DEMO_ACCOUNT_PASSWORD || DEMO_PASSWORD_FALLBACK;

  // El marketplace necesita carrito y checkout, que solo existen en HYBRID/DIRECT.
  if (settings.mode() === 'AFFILIATE') await settings.update({ commerceMode: 'HYBRID' });

  const account = async ({ email, firstName, lastName }) => {
    const existing = customers.byEmail(email);
    if (existing?.hasAccount) return existing;
    const created = await customers.register({ email, password, firstName, lastName });
    await customers.update(created.id, { tags: ['demo'] });
    return customers.repository.retrieve(created.id);
  };

  const fulfillment = container.resolve('fulfillment');
  if (!fulfillment.options.repository.find({ code: 'py-entrega-local' })) {
    await fulfillment.options.create({
      code: 'py-entrega-local', name: 'Entrega local (Carapeguá)', serviceZoneId: 'szone_py', shippingProfileId: 'sprof_default',
      priceType: 'flat', amount: 15000, currencyCode: 'PYG', rank: 7, active: true,
      description: 'Tarifa de demostración para entregas dentro de la ciudad.',
    });
  }

  const categoryId = handle => catalog.categories.repository.find({ handle })?.id || null;
  const summary = { stores: 0, products: 0 };
  for (const spec of STORES) {
    const owner = await account(spec.owner);
    const seller = await channel.sellers.create({
      code: spec.code, name: spec.name, type: spec.type, tagline: spec.tagline, description: spec.description,
      categoryIds: spec.categories.map(categoryId).filter(Boolean), localityId: 'loc_carapegua',
      location: { area: spec.area, public: spec.public, lat: spec.lat, lng: spec.lng },
      contactPhone: '+595 000 000000', deliveryModes: spec.delivery, payoutCurrency: 'PYG', status: 'pending',
      ownerCustomerId: owner.id, metadata: { demo: true },
      hours: [{ day: 'lunes', opens: '08:00', closes: '18:00' }, { day: 'sabado', opens: '08:00', closes: '12:00' }],
    });
    await mp.members.create({ sellerId: seller.id, customerId: owner.id, role: 'owner', status: 'active' });
    const application = await mp.applications.create({
      sellerId: seller.id, customerId: owner.id, status: 'pending', submittedAt: new Date().toISOString(), termsVersion: '2026-09', termsAcceptedAt: new Date().toISOString(),
    });
    await mp.accounts.decide(application.id, { decision: 'approve', note: 'Tienda de demostración.' });
    summary.stores += 1;
    for (const product of spec.products) {
      const created = await mp.listings.create({ sellerId: seller.id }, {
        name: product.name, description: product.description, categoryId: categoryId(product.category),
        price: product.price, compareAtPrice: product.compareAt, stock: product.stock, tags: product.tags,
        deliveryModes: spec.delivery, status: 'published',
      });
      await catalog.products.update(created.id, { image: product.emoji });
      summary.products += 1;
    }
  }

  // Producto propio de la plataforma.
  const own = await mp.listings.create({}, {
    name: 'Guía de artesanía de Carapeguá (impresa)', description: 'Producto propio de demostración: guía impresa con talleres y técnicas.',
    categoryId: categoryId('artesania'), price: 60000, stock: 30, tags: ['guía', 'artesanía'], deliveryModes: ['pickup', 'national_shipping'], status: 'published',
  });
  await catalog.products.update(own.id, { image: '📘' });

  // Proveedor de dropshipping con un producto.
  const dropshipping = container.resolve('dropshipping');
  const supplier = await dropshipping.suppliers.create({ code: 'proveedor-demo', name: 'Proveedor aliado (demo)', integrationType: 'csv', notes: 'Proveedor de demostración.' });
  await dropshipping.activate(supplier.id, 'active');
  const drop = await dropshipping.createProduct({
    supplierId: supplier.id, supplierSku: 'DEMO-TERMO-1L', cost: 70000, name: 'Termo de acero 1 litro',
    description: 'Producto de dropshipping de demostración: despacha el proveedor aliado.', categoryId: categoryId('cocina'),
    price: 115000, stock: 50, tags: ['termo', 'tereré'], status: 'published',
  });
  await catalog.products.update(drop.product.id, { image: '🧉' });

  // Comprador de demostración.
  await account({ email: 'comprador@demo.ndivepa.local', firstName: 'Carlos', lastName: 'Ramírez' });
  catalog.products.reindex();
  logger.info('Marketplace de demostración sembrado', summary);
  return { seeded: true, ...summary };
}
