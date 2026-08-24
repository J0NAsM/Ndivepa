import { buildSchema, graphql } from 'graphql';

const schema = buildSchema(`
  type Price { amount: Int currency: String previousAmount: Int }
  type Product { id: ID! name: String! handle: String status: String type: String monetizationType: String description: String image: String price: Price }
  type ProductPage { data: [Product!]! count: Int! limit: Int! offset: Int! hasMore: Boolean! }
  type StoreConfig { storeName: String defaultCurrency: String commerceMode: String }
  type AdminSummary { products: Int! orders: Int! customers: Int! }
  type Query { products(limit: Int = 20, offset: Int = 0): ProductPage! product(id: ID, handle: String): Product storeConfig: StoreConfig! adminSummary: AdminSummary }
`);
function productView(product) { return product ? { id: product.id, name: product.name, handle: product.handle, status: product.status, type: product.type, monetizationType: product.monetizationType, description: product.description, image: product.image, price: product.price || null } : null; }
export async function executeGraphql({ container, context, query, variables, operationName }) {
  const catalog = container.resolve('catalog').products; const settings = container.resolve('settings').settings;
  const rootValue = {
    products: ({ limit = 20, offset = 0 }) => { const result = catalog.list({ limit: Math.min(Math.max(limit, 1), 100), offset, filter: { status: 'published' } }); return { ...result, data: result.data.map(productView) }; },
    product: ({ id, handle }) => productView(id ? catalog.repository.byId(id) : catalog.repository.find({ handle, status: 'published' })),
    storeConfig: () => settings.publicView(),
    adminSummary: () => context.actor ? (() => { const state = container.resolve('store').read(); return { products: (state.products || []).length, orders: (state.orders || []).length, customers: (state.customers || []).length }; })() : null,
  };
  return graphql({ schema, source: query, rootValue, contextValue: context, variableValues: variables || {}, operationName });
}
