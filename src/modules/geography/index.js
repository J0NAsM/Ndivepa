/**
 * Geografía y regiones (M-0214 … M-0218).
 *
 * Equivalente a `region` de Medusa y a `zone`/`country`/`province`/`region` de
 * Vendure. Una **zona** agrupa países y provincias y es la unidad sobre la que se
 * resuelven impuestos y envíos; una **región** añade moneda y política fiscal.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ValidationError } from '../../framework/errors.js';

export const countryResource = defineResource({
  name: 'country',
  collection: 'countries',
  prefix: 'ctry',
  route: 'countries',
  unique: ['code'],
  searchable: ['name', 'code'],
  translatable: ['name'],
  fields: {
    code: rule.country({ required: true }),
    code3: rule.text(3, { lowercase: true }),
    numeric: rule.text(3),
    name: rule.text(100, { required: true }),
    officialName: rule.text(160),
    phonePrefix: rule.text(8),
    active: rule.flag({ default: true }),
    // Campos exigidos en una dirección de ese país (M-0268).
    requiredAddressFields: rule.list({ type: 'string' }, { default: ['firstName', 'lastName', 'address1', 'city', 'countryCode'] }),
    postalCodePattern: rule.text(120),
    metadata: rule.metadata(),
  },
});

export const provinceResource = defineResource({
  name: 'province',
  collection: 'provinces',
  prefix: 'prov',
  route: 'provinces',
  searchable: ['name', 'code'],
  translatable: ['name'],
  fields: {
    countryCode: rule.country({ required: true }),
    code: rule.text(12, { required: true }),
    name: rule.text(100, { required: true }),
    type: rule.enumOf(['province', 'state', 'department', 'region', 'district'], { default: 'department' }),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const zoneResource = defineResource({
  name: 'zone',
  collection: 'zones',
  prefix: 'zone',
  route: 'zones',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    countryCodes: rule.list({ type: 'string' }, { default: [] }),
    provinceIds: rule.list({ type: 'string' }, { default: [] }),
    postalCodes: rule.list({ type: 'string' }, { default: [] }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const regionResource = defineResource({
  name: 'region',
  collection: 'regions',
  prefix: 'reg',
  route: 'regions',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    currencyCode: rule.currency({ required: true }),
    countryCodes: rule.list({ type: 'string' }, { default: [] }),
    zoneIds: rule.list({ type: 'string' }, { default: [] }),
    taxInclusive: rule.flag({ default: false }),
    defaultTaxRateId: rule.id(),
    automaticTaxes: rule.flag({ default: true }),
    // Cada región puede tener su propio plazo de devolución (M-0703).
    returnWindowDays: { type: 'integer', coerce: true, min: 0, max: 365, default: 30 },
    shippingTaxable: rule.flag({ default: true }),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export class CountryService extends BaseService {
  constructor(deps) {
    super(deps, countryResource);
  }

  byCode(code) {
    return this.repository.find({ code: String(code || '').toLowerCase() });
  }

  /** Campos obligatorios de una dirección para ese país. */
  addressRequirements(code) {
    const country = this.byCode(code);
    return {
      required: country?.requiredAddressFields || ['firstName', 'lastName', 'address1', 'city', 'countryCode'],
      postalCodePattern: country?.postalCodePattern || null,
    };
  }
}

export class ProvinceService extends BaseService {
  constructor(deps) {
    super(deps, provinceResource);
  }

  forCountry(countryCode) {
    return this.repository.all({ countryCode: String(countryCode || '').toLowerCase(), active: true });
  }
}

export class ZoneService extends BaseService {
  constructor(deps) {
    super(deps, zoneResource);
  }

  /**
   * Resuelve la zona de una dirección (M-0218).
   * Se prueba de lo más específico a lo más general: código postal, provincia, país.
   * Entre empates gana la de mayor prioridad, para que una zona urbana pueda
   * anteponerse a la zona nacional.
   */
  resolve(address = {}) {
    const country = String(address.countryCode || '').toLowerCase();
    const postal = String(address.postalCode || '').trim();
    const candidates = this.repository.all({ active: true });

    const score = zone => {
      let points = 0;
      if (postal && zone.postalCodes?.length) {
        const match = zone.postalCodes.some(pattern => matchPostal(postal, pattern));
        if (!match) return -1;
        points += 100;
      }
      if (address.provinceId && zone.provinceIds?.length) {
        if (!zone.provinceIds.includes(address.provinceId)) return -1;
        points += 50;
      }
      if (zone.countryCodes?.length) {
        if (!country || !zone.countryCodes.includes(country)) return -1;
        points += 10;
      }
      return points;
    };

    return candidates
      .map(zone => ({ zone, points: score(zone) }))
      .filter(entry => entry.points >= 0)
      .sort((a, b) => b.points - a.points || b.zone.priority - a.zone.priority)[0]?.zone || null;
  }
}

export class RegionService extends BaseService {
  constructor(deps) {
    super(deps, regionResource);
    this.settings = deps.settings;
  }

  async beforeCreate(data) {
    const supported = this.settings.get('currencies', ['USD']);
    if (!supported.includes(data.currencyCode)) {
      throw ValidationError.single('currencyCode', `La moneda ${data.currencyCode} no está entre las soportadas por la tienda.`);
    }
    return data;
  }

  async beforeUpdate(existing, changes) {
    if (changes.currencyCode) await this.beforeCreate({ ...existing, ...changes });
    return changes;
  }

  byCode(code) {
    return this.repository.find({ code });
  }

  /** Región aplicable a un país; si no hay, la primera activa. */
  forCountry(countryCode) {
    const code = String(countryCode || '').toLowerCase();
    return (
      this.repository.all({ active: true }).find(region => (region.countryCodes || []).includes(code))
      || this.repository.all({ active: true })[0]
      || null
    );
  }

  default() {
    return this.repository.all({ active: true })[0] || null;
  }
}

/** Comodín simple: `1000`, `10*`, `1000-1500`. Sin expresiones regulares del usuario. */
function matchPostal(postal, pattern) {
  const clean = String(pattern).trim();
  if (clean.includes('-')) {
    const [from, to] = clean.split('-').map(part => part.trim());
    return postal >= from && postal <= to;
  }
  if (clean.endsWith('*')) return postal.startsWith(clean.slice(0, -1));
  return postal === clean;
}

const SEED_COUNTRIES = [
  { code: 'py', code3: 'pry', name: 'Paraguay', phonePrefix: '+595', requiredAddressFields: ['firstName', 'lastName', 'address1', 'city', 'countryCode'] },
  { code: 'ar', code3: 'arg', name: 'Argentina', phonePrefix: '+54', requiredAddressFields: ['firstName', 'lastName', 'address1', 'city', 'postalCode', 'countryCode'] },
  { code: 'br', code3: 'bra', name: 'Brasil', phonePrefix: '+55', requiredAddressFields: ['firstName', 'lastName', 'address1', 'city', 'postalCode', 'countryCode'] },
  { code: 'uy', code3: 'ury', name: 'Uruguay', phonePrefix: '+598' },
  { code: 'cl', code3: 'chl', name: 'Chile', phonePrefix: '+56' },
  { code: 'bo', code3: 'bol', name: 'Bolivia', phonePrefix: '+591' },
  { code: 'us', code3: 'usa', name: 'Estados Unidos', phonePrefix: '+1', requiredAddressFields: ['firstName', 'lastName', 'address1', 'city', 'provinceId', 'postalCode', 'countryCode'] },
  { code: 'es', code3: 'esp', name: 'España', phonePrefix: '+34', requiredAddressFields: ['firstName', 'lastName', 'address1', 'city', 'postalCode', 'countryCode'] },
  { code: 'mx', code3: 'mex', name: 'México', phonePrefix: '+52' },
  { code: 'co', code3: 'col', name: 'Colombia', phonePrefix: '+57' },
  { code: 'pe', code3: 'per', name: 'Perú', phonePrefix: '+51' },
];

const SEED_PROVINCES = [
  { countryCode: 'py', code: 'ASU', name: 'Asunción', type: 'district' },
  { countryCode: 'py', code: 'CEN', name: 'Central', type: 'department' },
  { countryCode: 'py', code: 'AAP', name: 'Alto Paraná', type: 'department' },
  { countryCode: 'py', code: 'ITA', name: 'Itapúa', type: 'department' },
];

export default {
  name: 'geography',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'translations', 'settings'],
  resources: [countryResource, provinceResource, zoneResource, regionResource],
  permissions: [
    { resource: 'country', description: 'Catálogo de países.' },
    { resource: 'province', description: 'Provincias y estados.' },
    { resource: 'zone', description: 'Zonas geográficas para impuestos y envío.' },
    { resource: 'region', description: 'Regiones de venta.' },
  ],

  register(deps) {
    return {
      countries: new CountryService(deps),
      provinces: new ProvinceService(deps),
      zones: new ZoneService(deps),
      regions: new RegionService(deps),
    };
  },

  async seed(service) {
    await service.countries.seed(SEED_COUNTRIES, 'code');
    await service.provinces.seed(SEED_PROVINCES.map(item => ({ ...item, id: `prov_${item.countryCode}_${item.code.toLowerCase()}` })), 'id');
    await service.zones.seed([
      { id: 'zone_py', code: 'paraguay', name: 'Paraguay', countryCodes: ['py'], priority: 100 },
      { id: 'zone_mercosur', code: 'mercosur', name: 'Mercosur', countryCodes: ['py', 'ar', 'br', 'uy'], priority: 80 },
      { id: 'zone_latam', code: 'latam', name: 'Latinoamérica', countryCodes: ['py', 'ar', 'br', 'uy', 'cl', 'bo', 'mx', 'co', 'pe'], priority: 60 },
      { id: 'zone_world', code: 'mundo', name: 'Resto del mundo', countryCodes: [], priority: 10 },
    ], 'id');
    await service.regions.seed([
      { id: 'reg_py', code: 'paraguay', name: 'Paraguay', currencyCode: 'USD', countryCodes: ['py'], zoneIds: ['zone_py'], taxInclusive: true, returnWindowDays: 30 },
      { id: 'reg_latam', code: 'latam', name: 'Latinoamérica', currencyCode: 'USD', countryCodes: ['ar', 'br', 'uy', 'cl', 'bo', 'mx', 'co', 'pe'], zoneIds: ['zone_latam'], returnWindowDays: 30 },
    ], 'id');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('geography');
      return [
        ...crudRoutes(countryResource, () => module().countries, { tags: ['geografía'] }),
        ...crudRoutes(provinceResource, () => module().provinces, { tags: ['geografía'] }),
        ...crudRoutes(zoneResource, () => module().zones, { tags: ['geografía'] }),
        ...crudRoutes(regionResource, () => module().regions, { tags: ['geografía'] }),
        {
          method: 'POST',
          path: '/zones/resolve',
          permission: 'zone:read',
          summary: 'Resuelve la zona aplicable a una dirección.',
          tags: ['geografía'],
          body: {
            countryCode: rule.country({ required: true }),
            provinceId: rule.id(),
            postalCode: rule.text(20),
          },
          handler: ctx => ({ zone: module().zones.resolve(ctx.body) }),
        },
      ];
    },
    store: container => {
      const module = () => container.resolve('geography');
      return [
        {
          method: 'GET',
          path: '/regions',
          permission: null,
          summary: 'Regiones activas.',
          tags: ['store'],
          bodyless: true,
          handler: () => {
            const data = module().regions.repository.all({ active: true }).map(region => ({
              id: region.id,
              code: region.code,
              name: region.name,
              currencyCode: region.currencyCode,
              countryCodes: region.countryCodes,
              taxInclusive: region.taxInclusive,
            }));
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/countries',
          permission: null,
          summary: 'Países activos con sus requisitos de dirección.',
          tags: ['store'],
          bodyless: true,
          handler: () => {
            const data = module().countries.repository.all({ active: true }).map(country => ({
              code: country.code,
              name: country.name,
              phonePrefix: country.phonePrefix,
              requiredAddressFields: country.requiredAddressFields,
            }));
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/countries/:code/provinces',
          permission: null,
          summary: 'Provincias de un país.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const data = module().provinces.forCountry(ctx.params.code);
            return { data, count: data.length };
          },
        },
      ];
    },
  },
};
