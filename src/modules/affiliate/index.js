/**
 * Afiliación: comercios, redes, programas, enlaces, conversiones, comisiones y pagos
 * (M-0153, M-0431 … M-0460, M-0731 … M-0760).
 *
 * Es el dominio original del proyecto y su regla de negocio más importante sigue
 * intacta: **una comisión pendiente no es ingreso**. Conversión, comisión y pago son
 * tres entidades distintas con estados propios, y la venta atribuida nunca se suma
 * al ingreso de la tienda.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, ValidationError } from '../../framework/errors.js';
import { validateAffiliateLink, deriveHealth } from './link-validation.js';
import { TrendsDiscoveryService } from './trends.js';
import { percentage, toMinor } from '../../framework/money.js';
import { ageInDays, now, toDate, DAY } from '../../framework/dates.js';
import { humanCode } from '../../framework/ids.js';

export const CONVERSION_STATUSES = ['pending', 'approved', 'rejected', 'paid'];
export const CONVERSION_TRANSITIONS = {
  pending: ['approved', 'rejected'],
  approved: ['paid', 'rejected'],
  rejected: ['pending'],
  paid: [],
};
export const COMMISSION_STATUSES = ['pending', 'approved', 'confirmed', 'rejected', 'paid'];

export const merchantResource = defineResource({
  name: 'merchant',
  collection: 'merchants',
  prefix: 'mer',
  route: 'merchants',
  searchable: ['name'],
  fields: {
    name: rule.text(120, { required: true }),
    domains: rule.list({ type: 'string' }, { default: [], minItems: 1 }),
    status: rule.enumOf(['active', 'paused', 'inactive'], { default: 'active' }),
    website: rule.url(),
    contactEmail: rule.email(),
    notes: rule.text(1000),
    metadata: rule.metadata(),
  },
});

export const networkResource = defineResource({
  name: 'network',
  collection: 'networks',
  prefix: 'net',
  route: 'networks',
  searchable: ['name'],
  fields: {
    name: rule.text(120, { required: true }),
    status: rule.enumOf(['active', 'paused', 'inactive'], { default: 'active' }),
    website: rule.url(),
    // Reglas de tracking que autoriza la red. Se respetan al pie de la letra.
    allowedTracking: {
      type: 'object',
      shape: {
        subId: rule.flag({ default: false }),
        sharedId: rule.flag({ default: false }),
        utm: rule.flag({ default: false }),
        redirect: rule.flag({ default: false }),
        deepLinks: rule.flag({ default: true }),
      },
    },
    cookieWindowDays: { type: 'integer', coerce: true, min: 0, max: 365 },
    payoutTermsDays: { type: 'integer', coerce: true, min: 0, max: 365 },
    notes: rule.text(1000),
    metadata: rule.metadata(),
  },
});

export const programResource = defineResource({
  name: 'program',
  collection: 'programs',
  prefix: 'prog',
  route: 'programs',
  searchable: ['name', 'trackingId'],
  fields: {
    name: rule.text(140, { required: true }),
    networkId: rule.id({ required: true }),
    merchantId: rule.id({ required: true }),
    affiliateId: rule.text(80),
    trackingId: rule.text(80),
    requiredTrackingKey: rule.text(40),
    approvalStatus: rule.enumOf(['pending', 'approved', 'revoked'], { default: 'pending' }),
    credentialsVerifiedAt: rule.date(),
    autoDiscovery: rule.flag({ default: false }),
    commissionType: rule.enumOf(['percentage', 'flat', 'tiered'], { default: 'percentage' }),
    estimatedCommission: { type: 'number', coerce: true, min: 0, max: 100000 },
    commissionCurrency: rule.currency(),
    // Tramos para `tiered`: `[{minAmount, percent|flat}]` (M-0563).
    commissionTiers: rule.list({
      type: 'object',
      shape: {
        minAmount: rule.minor({ required: true }),
        percent: rule.percent(),
        flat: rule.minor(),
      },
    }, { default: [] }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    status: rule.enumOf(['active', 'paused', 'inactive'], { default: 'active' }),
    termsUrl: rule.url(),
    notes: rule.text(1000),
    metadata: rule.metadata(),
  },
});

export const placementResource = defineResource({
  name: 'placement',
  collection: 'placements',
  prefix: 'plc',
  route: 'placements',
  searchable: ['name', 'key'],
  fields: {
    name: rule.text(120, { required: true }),
    key: rule.handle({ required: true }),
    description: rule.text(300),
    metadata: rule.metadata(),
  },
});

export const affiliateCampaignResource = defineResource({
  name: 'affiliateCampaign',
  collection: 'campaigns',
  prefix: 'camp',
  route: 'campaigns',
  searchable: ['name', 'code'],
  fields: {
    name: rule.text(140, { required: true }),
    code: rule.text(40, { required: true }),
    startsAt: rule.date(),
    endsAt: rule.date(),
    channel: rule.text(40),
    objective: rule.text(300),
    audience: rule.text(300),
    status: rule.enumOf(['draft', 'active', 'paused', 'finished'], { default: 'draft' }),
    metadata: rule.metadata(),
  },
});

export const affiliateLinkResource = defineResource({
  name: 'affiliateLink',
  collection: 'affiliateLinks',
  prefix: 'link',
  route: 'links',
  searchable: ['affiliateUrl', 'productUrl'],
  fields: {
    productId: rule.id({ required: true }),
    merchantId: rule.id(),
    programId: rule.id(),
    productUrl: rule.text(2048),
    affiliateUrl: rule.text(2048, { required: true }),
    finalUrl: rule.text(2048),
    label: rule.text(120),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    // Precio observado en el comercio, con su fecha de verificación (M-0551).
    merchantPrice: {
      type: 'object',
      shape: {
        amount: rule.minor(),
        currency: rule.currency(),
        verifiedAt: rule.date(),
        source: rule.enumOf(['manual', 'import_csv', 'feed']),
      },
    },
    coupon: {
      type: 'object',
      shape: {
        code: rule.text(60),
        description: rule.text(300),
        source: rule.text(120),
        seenAt: rule.date(),
        expiresAt: rule.date(),
      },
    },
    status: rule.enumOf(['valid', 'warning', 'invalid', 'pending_review'], { default: 'pending_review' }),
    reviewState: rule.enumOf(['none', 'queued', 'in_review', 'done'], { default: 'none' }),
    reviewAssignee: rule.id(),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const conversionResource = defineResource({
  name: 'conversion',
  collection: 'conversions',
  prefix: 'conv',
  route: 'conversions',
  unique: ['networkConversionId'],
  searchable: ['networkConversionId', 'clickId'],
  fields: {
    networkConversionId: rule.text(120),
    clickId: rule.text(60),
    productId: rule.id(),
    merchantId: rule.id(),
    networkId: rule.id(),
    programId: rule.id(),
    date: rule.date(),
    type: rule.enumOf(['purchase', 'lead', 'booking', 'subscription', 'other'], { default: 'purchase' }),
    // Importes en unidades mínimas: la venta atribuida es del comercio, no nuestra.
    saleAmount: rule.minor(),
    saleCurrency: rule.currency(),
    commission: rule.minor(),
    commissionCurrency: rule.currency(),
    // De dónde sale `commission`: lo que informó la red o lo que estima el
    // programa. Un importe estimado no se puede presentar como confirmado, y sin
    // esta marca las dos cosas eran indistinguibles en el panel.
    commissionSource: rule.enumOf(['reported', 'estimated', 'none'], { default: 'none' }),
    // Regla que produjo la estimación: `percentage`, `flat`, `tier_percent`, `tier_flat`.
    commissionBasis: rule.text(20),
    status: rule.enumOf(CONVERSION_STATUSES, { default: 'pending' }),
    source: rule.enumOf(['manual', 'import_csv', 'postback', 'api'], { default: 'manual' }),
    importId: rule.id(),
    reviewReason: rule.text(300),
    metadata: rule.metadata(),
  },
});

export const commissionResource = defineResource({
  name: 'commission',
  collection: 'commissions',
  prefix: 'com',
  route: 'commissions',
  searchable: [],
  fields: {
    conversionId: rule.id({ required: true }),
    productId: rule.id(),
    programId: rule.id(),
    amount: rule.minor({ required: true }),
    currency: rule.currency(),
    status: rule.enumOf(COMMISSION_STATUSES, { default: 'pending' }),
    approvedAt: rule.date(),
    payableAt: rule.date(),
    paidAt: rule.date(),
    payoutId: rule.id(),
    metadata: rule.metadata(),
  },
});

export const payoutResource = defineResource({
  name: 'payout',
  collection: 'payouts',
  prefix: 'payout',
  route: 'payouts',
  searchable: ['reference', 'networkId'],
  fields: {
    networkId: rule.id(),
    reference: rule.text(120),
    periodStart: rule.date(),
    periodEnd: rule.date(),
    amount: rule.minor({ required: true }),
    currency: rule.currency(),
    receivedAt: rule.date(),
    method: rule.enumOf(['transfer', 'paypal', 'check', 'other'], { default: 'transfer' }),
    commissionIds: rule.list({ type: 'string' }, { default: [] }),
    notes: rule.text(600),
    metadata: rule.metadata(),
  },
});

export class MerchantService extends BaseService {
  constructor(deps) { super(deps, merchantResource); }
}

export class NetworkService extends BaseService {
  constructor(deps) { super(deps, networkResource); }
}

export class ProgramService extends BaseService {
  constructor(deps) {
    super(deps, programResource);
  }

  /** Comisión estimada según el tipo y el tramo de precio (M-0561 … M-0563). */
  estimateCommission(program, saleAmountMinor) {
    if (!program) return null;
    const amount = Number(saleAmountMinor);
    if (program.commissionType === 'flat') {
      return { amount: toMinor(program.estimatedCommission, program.commissionCurrency || 'USD'), basis: 'flat' };
    }
    if (program.commissionType === 'tiered') {
      if (!Number.isFinite(amount)) return null;
      const tier = [...(program.commissionTiers || [])]
        .sort((a, b) => b.minAmount - a.minAmount)
        .find(entry => amount >= entry.minAmount);
      if (!tier) return null;
      return tier.flat
        ? { amount: tier.flat, basis: 'tier_flat', tier: tier.minAmount }
        : { amount: percentage(amount, tier.percent || 0), basis: 'tier_percent', tier: tier.minAmount };
    }
    if (!Number.isFinite(amount)) return null;
    return { amount: percentage(amount, program.estimatedCommission || 0), basis: 'percentage' };
  }

  /** Programas del mismo comercio ordenados por comisión estimada (M-0446, M-0447). */
  compareForMerchant(merchantId, saleAmountMinor = null) {
    return this.repository
      .all({ merchantId })
      .map(program => ({
        programId: program.id,
        name: program.name,
        status: program.status,
        commissionType: program.commissionType,
        estimatedCommission: program.estimatedCommission,
        estimated: this.estimateCommission(program, saleAmountMinor),
        priority: program.priority,
      }))
      .sort((a, b) => (b.estimated?.amount || 0) - (a.estimated?.amount || 0) || a.priority - b.priority);
  }

  /** Requisitos que impiden presentar como monetizable un programa incompleto. */
  discoveryReadiness(program) {
    const merchant = this.store.collection('merchants').find(row => row.id === program?.merchantId && !row.deletedAt);
    const network = this.store.collection('networks').find(row => row.id === program?.networkId && !row.deletedAt);
    const reasons = [];
    if (!program) reasons.push('El programa no existe.');
    if (program?.status !== 'active') reasons.push('El programa no está activo.');
    if (program?.approvalStatus !== 'approved') reasons.push('La afiliación no está marcada como aprobada.');
    if (!program?.credentialsVerifiedAt) reasons.push('Falta confirmar la verificación de credenciales.');
    if (!program?.autoDiscovery) reasons.push('La importación desde tendencias no está habilitada.');
    if (!program?.trackingId || !program?.requiredTrackingKey) reasons.push('Faltan el tracking ID o su parámetro requerido.');
    if (!merchant || merchant.status !== 'active') reasons.push('El comercio no está activo.');
    if (!network || network.status !== 'active') reasons.push('La red de afiliación no está activa.');
    return {
      eligible: reasons.length === 0,
      reasons,
      merchant: merchant ? { id: merchant.id, name: merchant.name } : null,
      network: network ? { id: network.id, name: network.name } : null,
    };
  }
}

export class AffiliateLinkService extends BaseService {
  constructor(deps) {
    super(deps, affiliateLinkResource);
    this.alerts = deps.alert;
    this.settings = deps.settings;
  }

  catalogContext() {
    return {
      merchants: this.store.collection('merchants'),
      programs: this.store.collection('programs'),
      networks: this.store.collection('networks'),
    };
  }

  /** Validación sin persistir, para el formulario del panel. */
  preview(input) {
    return validateAffiliateLink(this.catalogContext(), input);
  }

  async beforeCreate(data) {
    const product = this.store.collection('products').find(row => row.id === data.productId);
    const merchantId = data.merchantId || product?.merchantId || null;
    const programId = data.programId || product?.programId || null;
    const validation = this.preview({ ...data, merchantId, programId });
    if (validation.status === 'invalid') {
      throw new ValidationError(
        validation.messages.map(message => ({ field: 'affiliateUrl', message })),
        'El enlace de afiliado no es válido.',
      );
    }
    return {
      ...data,
      merchantId,
      programId,
      status: validation.status,
      validation,
      health: deriveHealth(validation, data.affiliateUrl),
      reviewState: validation.status === 'valid' ? 'done' : 'queued',
    };
  }

  /**
   * El estado, el diagnóstico y la salud son derivados: ningún cliente puede
   * declararlos válidos mediante PATCH sin que la URL se compruebe de nuevo.
   */
  async beforeUpdate(existing, changes) {
    const candidate = { ...existing, ...changes };
    const product = this.store.collection('products').find(row => row.id === candidate.productId);
    const merchantId = candidate.merchantId || product?.merchantId || null;
    const programId = candidate.programId || product?.programId || null;
    const validation = this.preview({
      affiliateUrl: candidate.affiliateUrl,
      productUrl: candidate.productUrl,
      merchantId,
      programId,
    });
    if (validation.status === 'invalid') {
      throw new ValidationError(
        validation.messages.map(message => ({ field: 'affiliateUrl', message })),
        'El enlace de afiliado no es válido.',
      );
    }
    return {
      ...changes,
      merchantId,
      programId,
      status: validation.status,
      validation,
      health: deriveHealth(validation, candidate.affiliateUrl),
      reviewState: validation.status === 'valid' ? 'done' : 'queued',
    };
  }

  async afterCreate(record, ctx) {
    if (record.status !== 'valid') {
      await this.alerts.raise({
        type: 'link_warning',
        severity: record.status === 'invalid' ? 'critical' : 'warning',
        message: `El enlace ${record.label || record.id} requiere revisión: ${record.validation?.messages?.[0] || 'sin detalle'}.`,
        entityId: record.id,
        entityType: 'affiliateLink',
      }, ctx);
    }
  }

  /**
   * Revalida un enlace. **Nunca modifica `affiliateUrl`**: solo actualiza el
   * diagnóstico. La prueba M-0457 protege esta garantía.
   */
  async revalidate(linkId, ctx = null) {
    const link = this.repository.retrieve(linkId);
    const product = this.store.collection('products').find(row => row.id === link.productId);
    const validation = this.preview({
      affiliateUrl: link.affiliateUrl,
      merchantId: link.merchantId || product?.merchantId,
      programId: link.programId || product?.programId,
    });
    const result = await this.store.transaction(state => this.repository.patch(state, linkId, {
      status: validation.status,
      validation,
      health: deriveHealth(validation, link.affiliateUrl),
      reviewState: validation.status === 'valid' ? 'done' : 'queued',
    }));
    if (validation.status !== 'valid') {
      await this.alerts.raise({
        type: 'link_validation',
        severity: validation.status === 'invalid' ? 'critical' : 'warning',
        message: `El enlace de ${product?.name || link.productId} requiere revisión: ${validation.messages[0]}`,
        entityId: link.id,
        entityType: 'affiliateLink',
      }, ctx);
    }
    await this.emit('validated', result.after, ctx, link);
    return result.after;
  }

  /** Validación en lote de todos los enlaces (M-0442). */
  async revalidateAll(ctx = null) {
    const links = this.repository.all({ active: true });
    const report = { checked: 0, valid: 0, warning: 0, invalid: 0 };
    for (const link of links) {
      const updated = await this.revalidate(link.id, ctx);
      report.checked += 1;
      report[updated.status] = (report[updated.status] || 0) + 1;
    }
    return report;
  }

  forProduct(productId) {
    return this.repository.all({ productId, active: true }).sort((a, b) => a.priority - b.priority);
  }

  /**
   * Elige el mejor enlace de un producto (M-0437, M-0572, M-0573).
   * Solo compite un precio **verificado**: un precio antiguo no se presenta como
   * actual y no gana la comparación.
   */
  bestFor(productId) {
    const staleDays = this.settings.get('affiliate.priceStaleDays', 30);
    const candidates = this.forProduct(productId).filter(link => link.status !== 'invalid');
    if (!candidates.length) return null;

    const scored = candidates.map(link => {
      const age = ageInDays(link.merchantPrice?.verifiedAt);
      const verified = age !== null && age <= staleDays && Number.isFinite(Number(link.merchantPrice?.amount));
      return { link, verified, amount: verified ? Number(link.merchantPrice.amount) : null, age };
    });

    const verified = scored.filter(entry => entry.verified);
    if (verified.length) {
      verified.sort((a, b) => a.amount - b.amount || a.link.priority - b.link.priority);
      return { ...verified[0].link, selectionReason: 'precio_verificado_mas_bajo', comparedWith: verified.length };
    }
    // Sin precios verificados, decide la prioridad del programa; no se compara precio.
    scored.sort((a, b) => a.link.priority - b.link.priority);
    return { ...scored[0].link, selectionReason: 'prioridad_programa', comparedWith: 0 };
  }

  /** Comparación de precio entre comercios; se oculta si no hay nada verificado (M-0576). */
  compare(productId) {
    const staleDays = this.settings.get('affiliate.priceStaleDays', 30);
    const rows = this.forProduct(productId).map(link => {
      const age = ageInDays(link.merchantPrice?.verifiedAt);
      return {
        linkId: link.id,
        merchantId: link.merchantId,
        merchantName: this.store.collection('merchants').find(row => row.id === link.merchantId)?.name || null,
        amount: link.merchantPrice?.amount ?? null,
        currency: link.merchantPrice?.currency || null,
        verifiedAt: link.merchantPrice?.verifiedAt || null,
        ageDays: age,
        verified: age !== null && age <= staleDays,
        status: link.status,
      };
    });
    const verified = rows.filter(row => row.verified);
    return {
      visible: verified.length > 0,
      reason: verified.length ? null : 'sin_precios_verificados',
      rows: rows.sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity)),
    };
  }

  /** Registro manual de precio del comercio, con autor e historial (M-0556, M-0559). */
  async recordMerchantPrice(linkId, { amount, currency = 'USD', source = 'manual' }, ctx = null) {
    const link = this.repository.retrieve(linkId);
    const previous = link.merchantPrice?.amount ?? null;
    const history = [
      ...(link.priceHistory || []),
      { amount, currency, verifiedAt: now(), source, actorId: ctx?.actor?.id || null },
    ].slice(-60);

    const result = await this.store.transaction(state => this.repository.patch(state, linkId, {
      merchantPrice: { amount, currency, verifiedAt: now(), source },
      priceHistory: history,
    }));

    if (previous !== null && previous > 0) {
      const variation = Math.round(((amount - previous) / previous) * 100);
      if (Math.abs(variation) >= 15) {
        await this.alerts.raise({
          type: variation < 0 ? 'affiliate_price_drop' : 'affiliate_price_jump',
          severity: 'info',
          message: `El precio del enlace ${link.label || link.id} varió ${variation} % (de ${previous} a ${amount}).`,
          entityId: link.id,
          entityType: 'affiliateLink',
        }, ctx);
      }
    }
    await this.emit('price_recorded', result.after, ctx, link);
    return result.after;
  }

  /** Cola de revisión de enlaces (M-0443). */
  reviewQueue() {
    return this.repository
      .all({ active: true })
      .filter(link => link.status !== 'valid' || link.reviewState === 'queued')
      .map(link => ({
        linkId: link.id,
        productId: link.productId,
        status: link.status,
        reviewState: link.reviewState,
        assignee: link.reviewAssignee || null,
        checkedAt: link.validation?.checkedAt || null,
        ageDays: ageInDays(link.validation?.checkedAt),
        reason: link.validation?.messages?.[0] || null,
      }))
      .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  }

  /** Salud del catálogo afiliado (M-0455). */
  health() {
    const links = this.repository.all({ active: true });
    const staleDays = this.settings.get('affiliate.linkStaleDays', 14);
    const stale = links.filter(link => (ageInDays(link.validation?.checkedAt) ?? Infinity) > staleDays);
    return {
      total: links.length,
      valid: links.filter(link => link.status === 'valid').length,
      warning: links.filter(link => link.status === 'warning').length,
      invalid: links.filter(link => link.status === 'invalid').length,
      pendingReview: links.filter(link => link.reviewState === 'queued').length,
      staleValidation: stale.length,
      staleValidationDays: staleDays,
    };
  }
}

export class ConversionService extends BaseService {
  constructor(deps) {
    super(deps, conversionResource);
    this.settings = deps.settings;
    this.programs = deps.programs;
    this.alerts = deps.alert;
  }

  /** Atribución al clic dentro de la ventana configurada (M-0740, M-0741). */
  attribute(conversion) {
    if (!conversion.clickId) return { clickId: null, attributed: false, reason: 'sin_click_id' };
    const windowDays = this.settings.get('affiliate.attributionWindowDays', 30);
    const click = this.store.collection('events').find(
      event => event.type === 'affiliate_click' && event.clickId === conversion.clickId,
    );
    if (!click) return { clickId: conversion.clickId, attributed: false, reason: 'click_no_encontrado' };
    const conversionAt = toDate(conversion.date)?.getTime() ?? Date.now();
    const clickAt = toDate(click.timestamp)?.getTime() ?? 0;
    if (conversionAt - clickAt > windowDays * DAY) {
      return { clickId: conversion.clickId, attributed: false, reason: 'fuera_de_ventana', windowDays };
    }
    if (click.fraudFlag) {
      return { clickId: conversion.clickId, attributed: false, reason: 'click_marcado_fraude' };
    }
    return {
      clickId: conversion.clickId,
      attributed: true,
      click: {
        productId: click.productId,
        merchantId: click.merchantId,
        networkId: click.networkId,
        campaignId: click.campaignId,
        source: click.source,
        timestamp: click.timestamp,
      },
    };
  }

  async beforeCreate(data) {
    // `networkConversionId` duplicado se rechaza (M-0743): la unicidad del repositorio
    // lo cubre, pero el mensaje explícito ayuda al importador.
    if (data.networkConversionId) {
      const duplicate = this.repository.find({ networkConversionId: data.networkConversionId });
      if (duplicate) {
        throw new ConflictError(`La conversión ${data.networkConversionId} ya está registrada.`, { conversionId: duplicate.id });
      }
    }
    const attribution = this.attribute(data);
    return {
      ...data,
      ...this.resolveCommission(data),
      date: data.date || now(),
      attribution,
      reviewReason: attribution.attributed ? null : `Revisión: ${attribution.reason}`,
    };
  }

  /**
   * Comisión de la conversión y su procedencia (M-0561 … M-0563).
   *
   * Si la red informa el importe, se respeta tal cual y se marca `reported`. Si
   * no lo informa, se estima con las reglas del programa —porcentaje, importe
   * fijo o tramo— y se marca `estimated`. Antes no se estimaba nada: `approve()`
   * creaba la comisión con `conversion.commission || 0`, así que toda conversión
   * importada sin columna de comisión generaba una comisión de importe cero y el
   * cálculo por tramos del programa no se usaba en ninguna parte.
   */
  resolveCommission(data) {
    const currency = data.commissionCurrency || data.saleCurrency || 'USD';
    // Ausente y cero no son lo mismo: una red puede informar una conversión con
    // comisión cero (devolución, producto excluido) y eso es un dato, no un hueco
    // que haya que rellenar con una estimación.
    const reported = data.commission;
    if (reported !== undefined && reported !== null && Number.isFinite(Number(reported))) {
      return { commission: Number(reported), commissionCurrency: currency, commissionSource: 'reported' };
    }
    const program = data.programId ? this.programs.repository.byId(data.programId) : null;
    const estimate = this.programs.estimateCommission(program, data.saleAmount);
    if (!estimate || !Number.isFinite(Number(estimate.amount))) {
      return { commission: 0, commissionCurrency: currency, commissionSource: 'none' };
    }
    return {
      commission: Number(estimate.amount),
      commissionCurrency: program?.commissionCurrency || currency,
      commissionSource: 'estimated',
      commissionBasis: estimate.basis,
    };
  }

  async afterCreate(record, ctx) {
    if (!record.attribution?.attributed) {
      await this.alerts.raise({
        type: 'conversion_unattributed',
        severity: 'warning',
        message: `La conversión ${record.networkConversionId || record.id} no se pudo atribuir: ${record.attribution?.reason}.`,
        entityId: record.id,
        entityType: 'conversion',
      }, ctx);
    }
  }

  assertTransition(conversion, target) {
    const allowed = CONVERSION_TRANSITIONS[conversion.status] || [];
    if (!allowed.includes(target)) {
      throw new ConflictError(`No se puede pasar la conversión de "${conversion.status}" a "${target}".`, {
        from: conversion.status, to: target, allowed,
      });
    }
  }

  /** Aprobar crea la comisión; es el único camino para que exista (M-0735). */
  async approve(conversionId, ctx = null) {
    const conversion = this.repository.retrieve(conversionId);
    this.assertTransition(conversion, 'approved');
    const commissions = this.deps.commissions;

    const result = await this.store.transaction(state => this.repository.patch(state, conversionId, {
      status: 'approved',
      approvedAt: now(),
    }));

    const existing = commissions.repository.find({ conversionId });
    if (!existing) {
      await commissions.create({
        conversionId,
        productId: conversion.productId,
        programId: conversion.programId,
        amount: conversion.commission || 0,
        currency: conversion.commissionCurrency || 'USD',
        status: 'approved',
        approvedAt: now(),
        metadata: { source: conversion.commissionSource || 'none', basis: conversion.commissionBasis || null },
      }, ctx);
    } else {
      await commissions.update(existing.id, { status: 'approved', approvedAt: now() }, ctx);
    }

    await this.emit('approved', result.after, ctx, conversion);
    return result.after;
  }

  async reject(conversionId, reason, ctx = null) {
    const conversion = this.repository.retrieve(conversionId);
    this.assertTransition(conversion, 'rejected');
    const result = await this.store.transaction(state => this.repository.patch(state, conversionId, {
      status: 'rejected',
      rejectedAt: now(),
      reviewReason: reason || conversion.reviewReason,
    }));
    const commission = this.deps.commissions.repository.find({ conversionId });
    if (commission) await this.deps.commissions.update(commission.id, { status: 'rejected' }, ctx);
    await this.emit('rejected', result.after, ctx, conversion);
    return result.after;
  }
}

export class CommissionService extends BaseService {
  constructor(deps) {
    super(deps, commissionResource);
  }

  /** Totales por estado. Nunca se agregan en una sola cifra de «ingreso». */
  totals() {
    const rows = this.repository.all();
    const sum = status => rows.filter(row => (Array.isArray(status) ? status.includes(row.status) : row.status === status))
      .reduce((total, row) => total + Number(row.amount || 0), 0);
    return {
      pending: sum('pending'),
      approved: sum(['approved', 'confirmed']),
      paid: sum('paid'),
      rejected: sum('rejected'),
      currency: rows[0]?.currency || 'USD',
    };
  }

  /** Comisiones aprobadas sin pago después del plazo (M-0739). */
  overdue({ days = 60 } = {}) {
    return this.repository
      .all({ status: { $in: ['approved', 'confirmed'] } })
      .map(row => ({ ...row, ageDays: ageInDays(row.approvedAt || row.createdAt) }))
      .filter(row => (row.ageDays ?? 0) > days);
  }
}

export class PayoutService extends BaseService {
  constructor(deps) {
    super(deps, payoutResource);
    this.commissions = deps.commissions;
  }

  async beforeCreate(data) {
    return { ...data, reference: data.reference || humanCode('PAY', 8) };
  }

  /** Al registrar un pago, las comisiones incluidas pasan a `paid` (M-0737). */
  async afterCreate(record, ctx) {
    for (const commissionId of record.commissionIds || []) {
      const commission = this.commissions.repository.byId(commissionId);
      if (!commission) continue;
      await this.commissions.update(commissionId, { status: 'paid', paidAt: record.receivedAt || now(), payoutId: record.id }, ctx);
    }
  }

  /** Conciliación entre comisiones aprobadas y pagos recibidos (M-0738). */
  reconcile() {
    const totals = this.commissions.totals();
    const received = this.repository.all().reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const difference = totals.paid - received;
    return {
      approvedPending: totals.approved,
      commissionsMarkedPaid: totals.paid,
      payoutsReceived: received,
      difference,
      balanced: difference === 0,
      note: difference === 0
        ? 'Las comisiones marcadas como pagadas coinciden con los pagos registrados.'
        : 'Hay una diferencia entre comisiones pagadas y pagos recibidos. Revisa los registros.',
    };
  }
}

export default {
  name: 'affiliate',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'settings', 'alert', 'logger'],
  resources: [
    merchantResource, networkResource, programResource, placementResource,
    affiliateCampaignResource, affiliateLinkResource, conversionResource,
    commissionResource, payoutResource,
  ],
  permissions: [
    { resource: 'merchant', description: 'Comercios afiliados.' },
    { resource: 'network', description: 'Redes de afiliación.' },
    { resource: 'program', description: 'Programas de afiliación.' },
    { resource: 'placement', description: 'Ubicaciones de tracking.' },
    { resource: 'affiliateCampaign', description: 'Campañas de afiliación.' },
    { resource: 'affiliateLink', description: 'Enlaces afiliados.' },
    { resource: 'conversion', description: 'Conversiones reportadas.' },
    { resource: 'commission', description: 'Comisiones.' },
    { resource: 'payout', description: 'Pagos de comisión recibidos.' },
  ],

  register(deps) {
    const merchants = new MerchantService(deps);
    const networks = new NetworkService(deps);
    const programs = new ProgramService(deps);
    const placements = new BaseService(deps, placementResource);
    const campaigns = new BaseService(deps, affiliateCampaignResource);
    const commissions = new CommissionService(deps);
    const links = new AffiliateLinkService({ ...deps, programs });
    const conversions = new ConversionService({ ...deps, programs, commissions });
    const payouts = new PayoutService({ ...deps, commissions });
    const discovery = new TrendsDiscoveryService(deps);
    return { merchants, networks, programs, placements, campaigns, links, conversions, commissions, payouts, discovery };
  },

  jobs: container => [
    {
      name: 'affiliate.revalidate-links',
      everyMs: 24 * 3_600_000,
      handler: async () => {
        const affiliate = container.resolve('affiliate');
        const staleDays = container.resolve('settings').settings.get('affiliate.linkStaleDays', 14);
        const stale = affiliate.links.repository
          .all({ active: true })
          .filter(link => (ageInDays(link.validation?.checkedAt) ?? Infinity) > staleDays);
        for (const link of stale) await affiliate.links.revalidate(link.id);
        return { revalidated: stale.length };
      },
    },
    {
      name: 'affiliate.overdue-commissions',
      everyMs: 24 * 3_600_000,
      handler: async () => {
        const affiliate = container.resolve('affiliate');
        const overdue = affiliate.commissions.overdue({ days: 60 });
        for (const commission of overdue) {
          await container.resolve('alert').raise({
            type: 'commission_unpaid',
            severity: 'warning',
            message: `La comisión ${commission.id} está aprobada desde hace ${commission.ageDays} días y sigue sin pago registrado.`,
            entityId: commission.id,
            entityType: 'commission',
          });
        }
        return { overdue: overdue.length };
      },
    },
  ],

  routes: {
    admin: container => {
      const module = () => container.resolve('affiliate');
      return [
        ...crudRoutes(merchantResource, () => module().merchants, { tags: ['afiliación'] }),
        ...crudRoutes(networkResource, () => module().networks, { tags: ['afiliación'] }),
        ...crudRoutes(programResource, () => module().programs, { tags: ['afiliación'] }),
        ...crudRoutes(placementResource, () => module().placements, { tags: ['afiliación'] }),
        ...crudRoutes(affiliateCampaignResource, () => module().campaigns, { permissionResource: 'affiliateCampaign', tags: ['afiliación'] }),
        ...crudRoutes(affiliateLinkResource, () => module().links, { permissionResource: 'affiliateLink', tags: ['afiliación'] }),
        ...crudRoutes(conversionResource, () => module().conversions, { tags: ['afiliación'] }),
        ...crudRoutes(commissionResource, () => module().commissions, { tags: ['afiliación'] }),
        ...crudRoutes(payoutResource, () => module().payouts, { tags: ['afiliación'] }),
        {
          method: 'GET',
          path: '/affiliate-opportunities',
          permission: 'product:create',
          summary: 'Descubre consultas en tendencia para revisarlas como posibles productos afiliados.',
          tags: ['afiliación', 'descubrimiento'],
          bodyless: true,
          query: {
            geo: rule.text(2),
            limit: { type: 'integer', coerce: true, min: 1, max: 100, default: 50 },
            refresh: rule.flag({ default: false }),
          },
          handler: async ctx => {
            const result = await module().discovery.trends({
              geo: ctx.query.geo,
              limit: ctx.query.limit,
              refresh: ctx.query.refresh,
            });
            const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
            const catalog = container.resolve('catalog');
            const existing = new Set(catalog.products.repository.all().map(product => normalize(product.name)));
            const programs = module().programs.repository.all().map(program => ({
              id: program.id,
              name: program.name,
              ...module().programs.discoveryReadiness(program),
            }));
            return {
              ...result,
              items: result.items
                .map(item => ({ ...item, alreadyCatalogued: existing.has(normalize(item.query)) }))
                .sort((left, right) => (
                  right.productLikelihood - left.productLikelihood
                  || (right.traffic || 0) - (left.traffic || 0)
                )),
              eligiblePrograms: programs.filter(program => program.eligible),
              blockedPrograms: programs.filter(program => !program.eligible),
            };
          },
        },
        {
          method: 'POST',
          path: '/affiliate-opportunities/import',
          permission: 'product:create',
          summary: 'Convierte una tendencia revisada en producto y enlace afiliado validados.',
          tags: ['afiliación', 'descubrimiento'],
          status: 201,
          body: {
            query: rule.text(200, { required: true }),
            name: rule.text(200, { required: true }),
            description: rule.longText({ required: true, minLength: 20 }),
            geo: rule.text(2),
            programId: rule.id({ required: true }),
            categoryId: rule.id(),
            productUrl: rule.url({ required: true }),
            affiliateUrl: rule.url({ required: true }),
            type: rule.enumOf(['physical', 'digital', 'service', 'course', 'bundle', 'subscription', 'other'], { default: 'other' }),
            price: { type: 'number', coerce: true, min: 0 },
            previousPrice: { type: 'number', coerce: true, min: 0 },
            currency: rule.currency({ default: 'USD' }),
            publish: rule.flag({ default: false }),
          },
          handler: async ctx => {
            container.resolve('rbac').assert(ctx.actor, 'affiliateLink:create');
            const body = ctx.body;
            const trend = await module().discovery.find(body.query, { geo: body.geo });
            if (!trend) throw ValidationError.single('query', 'La consulta ya no está en el feed de Google Trends seleccionado.');

            const program = module().programs.repository.retrieve(body.programId);
            const readiness = module().programs.discoveryReadiness(program);
            if (!readiness.eligible) {
              throw new ConflictError(`El programa afiliado no está listo: ${readiness.reasons.join(' ')}`, {
                programId: program.id,
                reasons: readiness.reasons,
              });
            }
            const merchant = module().merchants.repository.retrieve(program.merchantId);
            const validation = module().links.preview({
              affiliateUrl: body.affiliateUrl,
              productUrl: body.productUrl,
              merchantId: merchant.id,
              programId: program.id,
            });
            if (validation.status === 'invalid') {
              throw new ValidationError(
                validation.messages.map(message => ({ field: 'affiliateUrl', message })),
                'El enlace afiliado no permite atribuir la comisión.',
              );
            }

            const catalog = container.resolve('catalog');
            const duplicate = catalog.products.repository.all().find(product => (
              product.name.localeCompare(body.name, 'es', { sensitivity: 'base' }) === 0
            ));
            if (duplicate) throw new ConflictError('Ya existe un producto con ese nombre.', { productId: duplicate.id });

            const currency = body.currency || container.resolve('settings').settings.get('defaultCurrency', 'USD');
            const hasPrice = body.price !== '' && body.price !== null && body.price !== undefined;
            const hasPreviousPrice = body.previousPrice !== '' && body.previousPrice !== null && body.previousPrice !== undefined;
            const product = await catalog.products.create({
              name: body.name,
              description: body.description,
              categoryId: body.categoryId || null,
              categoryIds: body.categoryId ? [body.categoryId] : [],
              type: body.type,
              image: '🔎',
              merchantId: merchant.id,
              programId: program.id,
              monetizationType: 'AFFILIATE',
              status: 'draft',
              price: {
                amount: hasPrice ? toMinor(body.price, currency) : null,
                previousAmount: hasPreviousPrice ? toMinor(body.previousPrice, currency) : null,
                currency,
                source: 'manual',
                updatedAt: hasPrice ? now() : null,
              },
              metadata: {
                discovery: {
                  source: trend.source,
                  query: trend.query,
                  geo: String(body.geo || container.resolve('config').discovery.googleTrendsGeo).toUpperCase(),
                  approximateTraffic: trend.approximateTraffic,
                  trendPublishedAt: trend.publishedAt,
                  importedAt: now(),
                },
              },
            }, ctx);
            let link;
            try {
              link = await module().links.create({
                productId: product.id,
                merchantId: merchant.id,
                programId: program.id,
                productUrl: body.productUrl,
                affiliateUrl: body.affiliateUrl,
                label: `Google Trends: ${trend.query}`.slice(0, 120),
              }, ctx);
            } catch (error) {
              await catalog.products.delete(product.id, ctx).catch(() => {});
              throw error;
            }
            const finalProduct = body.publish
              ? await catalog.products.update(product.id, { status: 'published' }, ctx)
              : product;
            return { product: finalProduct, link, trend, published: finalProduct.status === 'published' };
          },
        },
        {
          method: 'POST',
          path: '/links/validate',
          permission: 'affiliateLink:read',
          summary: 'Valida un enlace antes de guardarlo, sin hacer peticiones externas.',
          tags: ['afiliación'],
          body: {
            affiliateUrl: rule.text(2048, { required: true }),
            merchantId: rule.id(),
            programId: rule.id(),
            productUrl: rule.text(2048),
          },
          handler: ctx => module().links.preview(ctx.body),
        },
        {
          method: 'POST',
          path: '/links/:id/validate',
          permission: 'affiliateLink:update',
          summary: 'Revalida un enlace guardado sin modificar su URL.',
          tags: ['afiliación'],
          handler: ctx => module().links.revalidate(ctx.params.id, ctx),
        },
        {
          method: 'POST',
          path: '/links/validate-all',
          permission: 'affiliateLink:update',
          summary: 'Revalida todos los enlaces activos.',
          tags: ['afiliación'],
          handler: ctx => module().links.revalidateAll(ctx),
        },
        {
          method: 'POST',
          path: '/links/:id/merchant-price',
          permission: 'affiliateLink:update',
          summary: 'Registra el precio observado en el comercio con su fecha de verificación.',
          tags: ['afiliación'],
          body: {
            amount: rule.minor({ required: true, min: 0 }),
            currency: rule.currency(),
            source: rule.enumOf(['manual', 'import_csv', 'feed']),
          },
          handler: ctx => module().links.recordMerchantPrice(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'GET',
          path: '/links/review-queue',
          permission: 'affiliateLink:read',
          summary: 'Cola de enlaces pendientes de revisión.',
          tags: ['afiliación'],
          bodyless: true,
          handler: () => {
            const data = module().links.reviewQueue();
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/links/health',
          permission: 'affiliateLink:read',
          summary: 'Salud del catálogo de enlaces.',
          tags: ['afiliación'],
          bodyless: true,
          handler: () => module().links.health(),
        },
        {
          method: 'GET',
          path: '/products/:id/link-comparison',
          permission: 'affiliateLink:read',
          summary: 'Comparación de precio entre comercios del mismo producto.',
          tags: ['afiliación'],
          bodyless: true,
          handler: ctx => ({
            comparison: module().links.compare(ctx.params.id),
            best: module().links.bestFor(ctx.params.id),
          }),
        },
        {
          method: 'GET',
          path: '/merchants/:id/program-comparison',
          permission: 'program:read',
          summary: 'Comparación de comisión estimada entre programas del comercio.',
          tags: ['afiliación'],
          bodyless: true,
          handler: ctx => {
            const rows = module().programs.compareForMerchant(ctx.params.id, ctx.query.saleAmount ? Number(ctx.query.saleAmount) : null);
            return { data: rows, count: rows.length, recommended: rows[0]?.programId || null };
          },
        },
        {
          method: 'POST',
          path: '/conversions/:id/approve',
          permission: 'conversion:update',
          summary: 'Aprueba una conversión y genera su comisión.',
          tags: ['afiliación'],
          handler: ctx => module().conversions.approve(ctx.params.id, ctx),
        },
        {
          method: 'POST',
          path: '/conversions/:id/reject',
          permission: 'conversion:update',
          summary: 'Rechaza una conversión con motivo.',
          tags: ['afiliación'],
          body: { reason: rule.text(300) },
          handler: ctx => module().conversions.reject(ctx.params.id, ctx.body.reason, ctx),
        },
        {
          method: 'GET',
          path: '/commissions/totals',
          permission: 'commission:read',
          summary: 'Comisión pendiente, aprobada y pagada, siempre separadas.',
          tags: ['afiliación'],
          bodyless: true,
          handler: () => module().commissions.totals(),
        },
        {
          method: 'GET',
          path: '/payouts/reconcile',
          permission: 'payout:read',
          summary: 'Conciliación entre comisiones pagadas y pagos recibidos.',
          tags: ['afiliación'],
          bodyless: true,
          handler: () => module().payouts.reconcile(),
        },
      ];
    },
  },
};
