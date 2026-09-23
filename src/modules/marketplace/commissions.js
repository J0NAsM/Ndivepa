/**
 * Resolución de comisiones del marketplace.
 *
 * Ningún porcentaje está en el código: todo sale de `commissionRules`. Cuando
 * varias reglas aplican a una misma línea gana la **más específica**:
 *
 *   producto > tienda > campaña > categoría (incluidas las antecesoras) >
 *   modelo comercial > global
 *
 * A igual especificidad decide `priority` y, después, la regla más reciente. El
 * resultado se congela en la línea del subpedido: cambiar una regla mañana no
 * reescribe lo que ya se vendió.
 */
import { isActiveNow } from '../../framework/dates.js';
import { percentage } from '../../framework/money.js';

const SPECIFICITY = { product: 60, seller: 50, campaign: 40, category: 30, commercialModel: 20, global: 10 };

export class CommissionResolver {
  constructor({ rules, store }) {
    this.rules = rules;
    this.store = store;
  }

  /** Ids de la categoría y sus antecesoras, para heredar reglas del árbol. */
  categoryLineage(categoryId) {
    const categories = new Map(this.store.collection('categories').map(row => [row.id, row]));
    const lineage = [];
    let cursor = categoryId ? categories.get(categoryId) : null;
    for (let guard = 0; cursor && guard < 12; guard += 1) {
      lineage.push(cursor.id);
      cursor = cursor.parentId ? categories.get(cursor.parentId) : null;
    }
    return lineage;
  }

  /**
   * Reglas candidatas para una línea, ordenadas de mejor a peor.
   * @param {{productId?:string, sellerId?:string, categoryId?:string, campaignId?:string, commercialModel?:string}} line
   */
  candidates(line) {
    const lineage = this.categoryLineage(line.categoryId);
    const matches = rule => {
      switch (rule.scope) {
        case 'global': return true;
        case 'commercialModel': return rule.scopeValue === line.commercialModel;
        case 'category': return lineage.includes(rule.scopeValue);
        case 'campaign': return Boolean(line.campaignId) && rule.scopeValue === line.campaignId;
        case 'seller': return Boolean(line.sellerId) && rule.scopeValue === line.sellerId;
        case 'product': return rule.scopeValue === line.productId;
        default: return false;
      }
    };
    const depth = rule => (rule.scope === 'category' ? lineage.length - lineage.indexOf(rule.scopeValue) : 0);
    return this.rules.repository
      .all({ active: true })
      .filter(rule => isActiveNow(rule))
      .filter(matches)
      .sort((a, b) => (SPECIFICITY[b.scope] - SPECIFICITY[a.scope])
        // Entre categorías, la más profunda (más cercana al producto) gana.
        || depth(b) - depth(a)
        || (b.priority || 0) - (a.priority || 0)
        || String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /**
   * Regla efectiva, incluidas las fuentes heredadas: el porcentaje del plan y el
   * `commissionPercent` del vendedor anterior a la v4 cuentan como reglas de tienda.
   */
  resolve(line) {
    const [best] = this.candidates(line);
    const seller = line.sellerId ? this.store.collection('sellers').find(row => row.id === line.sellerId) : null;
    const plan = seller?.planId ? this.store.collection('sellerPlans').find(row => row.id === seller.planId && row.active !== false) : null;
    const inherited = [];
    if (plan && Number.isFinite(Number(plan.commissionPercent))) {
      inherited.push({ id: `plan:${plan.id}`, name: `Plan ${plan.name}`, scope: 'seller', percent: Number(plan.commissionPercent), flat: 0, source: 'plan' });
    }
    if (seller && (Number(seller.commissionPercent) > 0 || Number(seller.commissionFlat) > 0)) {
      inherited.push({ id: `seller:${seller.id}`, name: 'Comisión de la tienda', scope: 'seller', percent: Number(seller.commissionPercent || 0), flat: Number(seller.commissionFlat || 0), source: 'seller' });
    }
    // Una regla explícita de producto o de tienda manda sobre lo heredado.
    if (best && SPECIFICITY[best.scope] >= SPECIFICITY.seller) return { ...best, source: 'rule' };
    if (inherited.length) return inherited[0];
    if (best) return { ...best, source: 'rule' };
    return { id: null, name: 'Sin regla configurada', scope: 'none', percent: 0, flat: 0, source: 'none' };
  }

  /** Comisión de una línea sobre su base (importe tras descuentos de la tienda). */
  compute(line, base) {
    const applied = this.resolve(line);
    const amount = Math.max(0, Math.min(base, percentage(base, applied.percent || 0) + Number(applied.flat || 0)));
    return {
      amount,
      rule: { id: applied.id, name: applied.name, scope: applied.scope, percent: applied.percent || 0, flat: applied.flat || 0, source: applied.source },
    };
  }
}
