/**
 * Campos personalizados por entidad (M-0103, M-0104, M-0308).
 *
 * Equivalente al `custom-field` de Vendure. Permite añadir un atributo a producto o
 * cliente sin migrar el esquema, y distingue los públicos (visibles en la API de
 * tienda) de los internos (solo en el panel).
 */
import { validate, rule as ruleShortcuts } from './validate.js';

const TYPE_RULES = {
  string: extra => ({ type: 'string', maxLength: 2000, ...extra }),
  text: extra => ({ type: 'string', maxLength: 20000, ...extra }),
  number: extra => ({ type: 'number', coerce: true, ...extra }),
  integer: extra => ({ type: 'integer', coerce: true, ...extra }),
  boolean: extra => ({ type: 'boolean', coerce: true, ...extra }),
  date: extra => ruleShortcuts.date(extra),
  select: extra => ({ type: 'string', ...extra }),
  multiselect: extra => ({ type: 'array', coerce: true, items: { type: 'string' }, ...extra }),
  money: extra => ruleShortcuts.minor(extra),
  url: extra => ruleShortcuts.url(extra),
  json: extra => ({ type: 'object', shape: {}, allowUnknown: true, ...extra }),
};

export class CustomFieldRegistry {
  constructor() {
    this.fields = new Map();
  }

  /**
   * @param {string} entity nombre de la entidad (`product`, `customer`…)
   * @param {{key:string,type:string,label:string,public?:boolean,required?:boolean,
   *          options?:string[],min?:number,max?:number,maxLength?:number}} definition
   */
  declare(entity, definition) {
    if (!TYPE_RULES[definition.type]) {
      throw new Error(`Tipo de campo personalizado no soportado: ${definition.type}`);
    }
    if (!this.fields.has(entity)) this.fields.set(entity, new Map());
    this.fields.get(entity).set(definition.key, {
      public: false,
      required: false,
      ...definition,
    });
    return this;
  }

  for(entity) {
    return [...(this.fields.get(entity)?.values() || [])];
  }

  /** Esquema de validación de los campos personalizados de una entidad. */
  schema(entity, { onlyPublic = false } = {}) {
    const schema = {};
    for (const field of this.for(entity)) {
      if (onlyPublic && !field.public) continue;
      const extra = { required: field.required };
      if (field.maxLength) extra.maxLength = field.maxLength;
      if (field.min !== undefined) extra.min = field.min;
      if (field.max !== undefined) extra.max = field.max;
      if (field.options?.length) extra.enum = field.options;
      schema[field.key] = TYPE_RULES[field.type](extra);
    }
    return schema;
  }

  /** Valida el objeto `customFields` de una entidad. */
  validate(entity, input, { partial = true } = {}) {
    const schema = this.schema(entity);
    if (!Object.keys(schema).length) return {};
    return validate(input || {}, schema, { partial });
  }

  /** Filtra los campos internos antes de exponer la entidad al público (M-0104). */
  publicOnly(entity, customFields = {}) {
    const allowed = new Set(this.for(entity).filter(field => field.public).map(field => field.key));
    return Object.fromEntries(Object.entries(customFields).filter(([key]) => allowed.has(key)));
  }

  catalog() {
    return Object.fromEntries(
      [...this.fields.entries()].map(([entity, fields]) => [entity, [...fields.values()]]),
    );
  }
}
