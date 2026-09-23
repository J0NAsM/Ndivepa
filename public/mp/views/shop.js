/** Carrito multivendedor y checkout unificado. Los importes siempre vienen del backend. */
import { $, $$, api, bindForm, emit, esc, loadCart, money, navigate, query, state, storage, toast } from '../core.js';
import { avatar, DELIVERY_LABELS, empty, formError, media, productCard, rail } from '../ui.js';

/**
 * Resumen de importes. `estimate` es la suma de la opción más barata de cada
 * tienda: mostrar el envío ya en el carrito evita la sorpresa del checkout, que
 * es el primer motivo de abandono.
 */
function totals(cart, estimate = null) {
  const currency = cart.currencyCode;
  const row = (label, value, cls = '') => `<div class="row ${cls}"><span>${label}</span><span>${value}</span></div>`;
  return `<div class="totals">
    ${row('Subtotal', money(cart.subtotal, currency))}
    ${cart.discountTotal ? row('Descuentos', `−${money(cart.discountTotal, currency)}`) : ''}
    ${row('Envío', cart.shippingMethod || (cart.shippingMethods || []).length
      ? money(cart.shippingTotal, currency)
      : (estimate?.total > 0 ? `desde ${money(estimate.total, currency)}` : estimate?.total === 0 ? 'sin coste con retiro' : 'Se calcula en el checkout'))}
    ${(cart.shippingMethods || []).length > 1 ? (cart.shippingMethods || []).map(method => `<div class="row small muted"><span>· ${esc(method.name)}</span><span>${money(method.amount, currency)}</span></div>`).join('') : ''}
    ${cart.taxTotal ? row('Impuestos', money(cart.taxTotal, currency)) : ''}
    ${cart.giftCardTotal ? row('Tarjeta regalo', `−${money(cart.giftCardTotal, currency)}`) : ''}
    ${cart.loyaltyTotal ? row('Puntos canjeados', `−${money(cart.loyaltyTotal, currency)}`) : ''}
    ${row('Total', money(cart.payableTotal ?? cart.total, currency), 'total')}
    ${cart.taxInclusive ? '<span class="small muted">Precios con IVA incluido.</span>' : ''}
  </div>`;
}

/** La opción más barata de cada tienda: el «desde» que se muestra en el resumen. */
function estimateFrom(groups) {
  const shipping = (groups || []).filter(group => group.requiresShipping);
  if (!shipping.length || shipping.some(group => !group.options?.length)) return null;
  return { total: shipping.reduce((sum, group) => sum + Math.min(...group.options.map(option => option.amount)), 0) };
}

/** Aviso de entrega por tienda: cuánto cuesta, cuándo llega y qué falta para el envío gratis. */
function deliveryHint(group, currency) {
  if (!group?.options?.length) return '';
  const cheapest = [...group.options].sort((a, b) => a.amount - b.amount)[0];
  const free = group.options.map(option => option.freeOverAmount).filter(value => value > 0).sort((a, b) => a - b)[0];
  const missing = free ? free - group.subtotal : 0;
  const days = cheapest.estimatedDaysMax === 0 ? ' · hoy'
    : cheapest.estimatedDaysMin === 0 && cheapest.estimatedDaysMax === 1 ? ' · hoy o mañana'
      : cheapest.estimatedDaysMax ? ` · en ${cheapest.estimatedDaysMin ?? 1} a ${cheapest.estimatedDaysMax} días` : '';
  return `<p class="small muted" style="margin:4px 0 0">${esc(cheapest.modeLabel || 'Entrega')}: ${cheapest.amount > 0 ? money(cheapest.amount, currency) : 'sin coste'}${days}</p>
    ${missing > 0 ? `<p class="small" style="margin:2px 0 0;color:var(--ok)">Te faltan ${money(missing, currency)} para el envío gratis de esta tienda.</p>` : ''}`;
}

export async function cart() {
  const current = await loadCart();
  if (!current || !current.items?.length) {
    return { title: 'Carrito', html: `<div class="wrap page"><h1>Carrito</h1>${empty('Tu carrito está vacío.', { emoji: '🛒', action: '<a class="btn" href="/">Descubrir productos</a>' })}</div>` };
  }
  const warnings = current.warnings || [];
  const delivery = await api(`/marketplace/carts/${state.cartId}/shipping-options${state.locality ? `?locality=${encodeURIComponent(state.locality)}` : ''}`).catch(() => ({ data: [] }));
  const byGroup = new Map((delivery.data || []).map(group => [group.key, group]));
  const estimate = estimateFrom(delivery.data);
  const firstHandle = current.items.find(line => line.handle)?.handle;
  const suggestions = firstHandle
    ? (await api(`/marketplace/products/${encodeURIComponent(firstHandle)}/recommendations`).catch(() => ({})))
    : {};
  const alsoBuy = [...(suggestions.sameStore || []), ...(suggestions.related || [])]
    .filter(item => !current.items.some(line => line.productId === item.id))
    .slice(0, 6);
  return {
    title: 'Carrito',
    html: `<div class="wrap page">
      <h1>Carrito</h1>
      ${warnings.map(warning => `<div class="notice warn">${esc(warning.message)}</div>`).join('')}
      <div class="cart-layout">
        <div class="stack">
          ${current.groups.map(group => `<section class="card">
            <div class="split" style="margin-bottom:6px"><div style="display:flex;gap:10px;align-items:center">${group.seller ? avatar(group.seller) : ''}<div><strong>${group.seller ? `<a href="/tienda/${esc(group.seller.code)}">${esc(group.title)}</a>` : esc(group.title)}</strong>
              ${group.seller?.deliveryModes?.length ? `<div class="small muted">${group.seller.deliveryModes.map(mode => esc(DELIVERY_LABELS[mode] || mode)).join(' · ')}</div>` : ''}</div></div>
              <span class="small muted">${money(group.subtotal, current.currencyCode)}</span></div>
            ${deliveryHint(byGroup.get(group.key), current.currencyCode)}
            ${group.items.map(line => `<div class="line">
              <a href="${line.handle ? `/producto/${esc(line.handle)}` : '#'}">${media({ image: line.image, emoji: line.emoji, name: line.title })}</a>
              <div class="stack" style="gap:6px">
                <div class="split"><strong>${esc(line.title)}</strong><button class="linkish small" data-remove="${esc(line.id)}">Quitar</button></div>
                ${line.variantTitle && line.variantTitle !== 'Estándar' ? `<span class="small muted">${esc(line.variantTitle)}</span>` : ''}
                <div class="split">
                  <div class="qty"><button type="button" data-line="${esc(line.id)}" data-delta="-1" aria-label="Menos">−</button><input type="number" value="${line.quantity}" min="1" max="999" data-line-qty="${esc(line.id)}" aria-label="Cantidad"><button type="button" data-line="${esc(line.id)}" data-delta="1" aria-label="Más">+</button></div>
                  <span class="price">${money(line.subtotalAfterDiscount ?? line.total, current.currencyCode)}</span>
                </div>
                ${line.discountTotal ? `<span class="small" style="color:var(--ok)">Ahorrás ${money(line.discountTotal, current.currencyCode)}</span>` : ''}
              </div>
            </div>`).join('')}
          </section>`).join('')}
          ${current.groups.length > 1 ? `<p class="small muted">Tu compra incluye ${current.groups.length} tiendas. Pagás una sola vez y cada tienda prepara su parte; vas a ver el avance de cada una.</p>` : ''}
        </div>
        <aside class="card stack">
          <h2>Resumen</h2>
          ${totals(current, estimate)}
          ${estimate && delivery.estimatedFor ? `<p class="small muted" style="margin:0">Envío estimado para ${esc(delivery.estimatedFor.name)}. Se confirma con tu dirección en el checkout.</p>` : ''}
          <form data-coupon class="btn-row">${formError()}<input type="text" name="code" placeholder="Cupón de descuento" style="flex:1" aria-label="Cupón"><button class="btn ghost" type="submit">Aplicar</button></form>
          ${(current.couponCodes || []).map(code => `<div class="split small"><span>Cupón <strong>${esc(code)}</strong></span><button class="linkish" data-remove-coupon="${esc(code)}">Quitar</button></div>`).join('')}
          <a class="btn accent block" href="/checkout">Continuar compra</a>
        </aside>
      </div>
      ${alsoBuy.length ? `<section class="section"><div class="section-head"><h2>Completá tu compra</h2></div>${rail(alsoBuy, item => productCard(item))}</section>` : ''}
    </div>`,
    mount(root) {
      const refresh = async () => { await loadCart(); emit('route'); };
      const setQuantity = async (lineId, quantity) => {
        try {
          if (quantity <= 0) await api(`/carts/${state.cartId}/line-items/${lineId}`, { method: 'DELETE' });
          else await api(`/carts/${state.cartId}/line-items/${lineId}`, { method: 'PATCH', body: { quantity } });
        } catch (error) { toast(error.message); }
        await refresh();
      };
      $$('[data-delta]', root).forEach(button => button.addEventListener('click', () => {
        const line = state.cart.items.find(item => item.id === button.dataset.line);
        setQuantity(line.id, line.quantity + Number(button.dataset.delta));
      }));
      $$('[data-line-qty]', root).forEach(input => input.addEventListener('change', () => setQuantity(input.dataset.lineQty, Number(input.value))));
      $$('[data-remove]', root).forEach(button => button.addEventListener('click', () => setQuantity(button.dataset.remove, 0)));
      bindForm($('[data-coupon]', root), async values => {
        if (!values.code) return;
        await api(`/carts/${state.cartId}/coupons`, { method: 'POST', body: { code: values.code } });
        toast('Cupón aplicado');
        await refresh();
      });
      $$('[data-remove-coupon]', root).forEach(button => button.addEventListener('click', async () => {
        await api(`/carts/${state.cartId}/coupons/${encodeURIComponent(button.dataset.removeCoupon)}`, { method: 'DELETE' });
        await refresh();
      }));
    },
  };
}

/**
 * Lo que protege la compra, dicho junto al botón de confirmar: devolución real,
 * medios de pago configurados y el compromiso de no guardar datos de tarjeta.
 */
function guarantees() {
  const trust = state.config?.trust || {};
  const points = [];
  if (trust.returnWindowDays) points.push(`Tenés ${trust.returnWindowDays} días para devolver lo que no te sirva.`);
  points.push('Ndivepa no guarda datos de tarjetas.');
  points.push('Los pagos por transferencia se confirman al verificar el comprobante.');
  if (trust.contactEmail || trust.contactPhone) {
    points.push(`Ante cualquier problema: ${esc(trust.contactPhone || trust.contactEmail)}.`);
  }
  return `<ul class="small muted" style="margin:0;padding-left:18px">${points.map(point => `<li>${point}</li>`).join('')}</ul>`;
}

/** Plazo consolidado de la compra una vez elegidas las entregas. */
function deliverySummary(cart) {
  const methods = cart.shippingMethods || [];
  const maxDays = methods.map(method => method.estimatedDaysMax).filter(value => value !== null && value !== undefined);
  if (!maxDays.length) return 'La tienda confirma el plazo al preparar tu pedido.';
  const worst = Math.max(...maxDays);
  return worst <= 1 ? 'Lo recibís hoy o mañana.' : `Lo recibís en hasta ${worst} día(s).`;
}

export async function checkout() {
  const current = await loadCart();
  if (!current?.items?.length) {
    navigate('/carrito', { replace: true });
    return { title: 'Checkout', html: '' };
  }
  const address = current.shippingAddress || {};
  const me = state.me || {};
  const hasAddress = Boolean(address.address1);
  let groups = [];
  let methods = [];
  if (hasAddress) {
    [groups, methods] = await Promise.all([
      api(`/marketplace/carts/${state.cartId}/shipping-options`).then(result => result.data),
      api(`/carts/${state.cartId}/payment-methods`).then(result => result.data),
    ]);
  }
  // Cada tienda elige su propia entrega: retiro en una y envío en otra es lo normal.
  const shippingDone = groups.length > 0 && groups.every(group => group.selectedOptionId);
  // El backend es quien sabe si algo dejó de estar disponible o cambió de precio:
  // mejor enterarse aquí que al confirmar el pago.
  const progress = await api(`/carts/${state.cartId}/checkout`).catch(() => ({ blockers: [] }));
  const alerts = [...(progress.blockers || []), ...(current.warnings || [])]
    .filter((item, index, list) => list.findIndex(other => other.message === item.message) === index);
  const step = !hasAddress ? 1 : !shippingDone ? 2 : 3;
  return {
    title: 'Finalizar compra',
    html: `<div class="wrap page">
      <h1>Finalizar compra</h1>
      <div class="steps"><span class="on">1. Datos</span>›<span class="${step >= 2 ? 'on' : ''}">2. Entrega</span>›<span class="${step >= 3 ? 'on' : ''}">3. Pago</span></div>
      ${alerts.map(alert => `<div class="notice warn">${esc(alert.message)}</div>`).join('')}
      ${!state.me ? `<div class="notice"><strong>Seguí como invitado.</strong> No hace falta crear una cuenta para comprar: completá tus datos y listo.
        <span class="small">Si ya tenés cuenta, <a href="/ingresar?volver=/checkout">ingresá</a> y se completan solos.</span></div>` : ''}
      <div class="cart-layout">
        <div class="stack">
          <section class="card">
            <h2>1. Tus datos</h2>
            <form data-address class="stack">${formError()}
              <div class="grid-2">
                <label>Nombre<input type="text" name="firstName" required autocomplete="given-name" value="${esc(address.firstName || me.firstName || '')}"></label>
                <label>Apellido<input type="text" name="lastName" required autocomplete="family-name" value="${esc(address.lastName || me.lastName || '')}"></label>
              </div>
              <div class="grid-2">
                <label>Correo<input type="email" inputmode="email" name="email" required autocomplete="email" value="${esc(current.email || me.email || '')}"></label>
                <label>Teléfono<input type="tel" inputmode="tel" name="phone" required autocomplete="tel" value="${esc(address.phone || me.phone || '')}"></label>
              </div>
              <label>Dirección<input type="text" name="address1" required autocomplete="street-address" value="${esc(address.address1 || '')}" placeholder="Calle, número y referencia"></label>
              <div class="grid-2">
                <label>Ciudad<input type="text" name="city" required autocomplete="address-level2" value="${esc(address.city || 'Carapeguá')}"></label>
                <label>Departamento<input type="text" name="province" autocomplete="address-level1" value="${esc(address.province || 'Paraguarí')}"></label>
              </div>
              <label>Indicaciones para la entrega (opcional)<input type="text" name="instructions" value="${esc(address.instructions || '')}"></label>
              <button class="btn ${hasAddress ? 'ghost' : ''}" type="submit">${hasAddress ? 'Actualizar datos' : 'Continuar'}</button>
            </form>
          </section>
          ${hasAddress ? `<section class="card">
            <h2>2. Entrega</h2>
            ${groups.length > 1 ? '<p class="small muted">Tu compra viene de varias tiendas: elegí cómo recibís cada parte.</p>' : ''}
            <form data-shipping>${groups.map(group => `<fieldset style="border:0;padding:0;margin:0 0 14px">
              <legend class="small"><strong>${esc(group.title)}</strong> · ${group.itemCount} artículo(s)</legend>
              ${group.options.length ? group.options.map(option => `<label class="option"><input type="radio" name="group:${esc(group.key)}" value="${esc(option.id)}" ${option.id === group.selectedOptionId ? 'checked' : ''}><span><strong>${esc(option.modeLabel)}: ${esc(option.name)}</strong> · ${option.amount ? money(option.amount, option.currencyCode || current.currencyCode) : 'Gratis'}<br><span class="small muted">${esc(option.description || '')}${option.estimatedDaysMax !== null && option.estimatedDaysMax !== undefined ? ` Plazo estimado: ${option.estimatedDaysMin}–${option.estimatedDaysMax} día(s).` : ''}</span></span></label>`).join('')
                : '<p class="notice warn">Esta tienda no tiene entregas disponibles para tu dirección. Consultale antes de continuar.</p>'}
            </fieldset>`).join('')}</form>
            ${groups.length && !shippingDone ? '<p class="small muted">Elegí una opción para cada tienda para continuar.</p>' : ''}
          </section>` : ''}
          ${shippingDone ? `<section class="card">
            <h2>3. Pago</h2>
            <form data-payment class="stack">${formError()}
              ${methods.map((method, index) => `<label class="option"><input type="radio" name="paymentMethodId" value="${esc(method.id)}" ${index === 0 ? 'checked' : ''} ${method.requiresCredentials ? 'disabled' : ''}><span><strong>${esc(method.name)}</strong><br><span class="small muted">${esc(method.description || '')}${method.requiresCredentials ? ' (no disponible)' : ''}</span>${method.instructions ? `<br><span class="small">${esc(method.instructions)}</span>` : ''}</span></label>`).join('')}
              ${guarantees()}
              <button class="btn accent block" type="submit">Confirmar pedido · ${money(current.payableTotal ?? current.total, current.currencyCode)}</button>
            </form>
          </section>` : ''}
        </div>
        <aside class="card stack">
          <h2>Tu pedido</h2>
          ${current.groups.map(group => `<div><strong class="small">${esc(group.title)}</strong>${group.items.map(line => `<div class="split small"><span>${line.quantity} × ${esc(line.title)}</span><span>${money(line.subtotalAfterDiscount ?? line.total, current.currencyCode)}</span></div>`).join('')}</div>`).join('')}
          <hr style="margin:4px 0">${totals(current)}
          ${shippingDone ? `<p class="small muted">${deliverySummary(current)}</p>` : ''}
        </aside>
      </div>
    </div>`,
    mount(root) {
      bindForm($('[data-address]', root), async values => {
        await api(`/carts/${state.cartId}/addresses`, {
          method: 'POST',
          body: {
            email: values.email,
            shippingAddress: {
              firstName: values.firstName, lastName: values.lastName, phone: values.phone, address1: values.address1,
              city: values.city, province: values.province, countryCode: 'py', instructions: values.instructions || undefined,
            },
          },
        });
        emit('route');
      });
      // Se envía la selección completa: el backend valida grupo por grupo.
      $$('[data-shipping] input', root).forEach(input => input.addEventListener('change', async () => {
        const selections = $$('[data-shipping] input:checked', root)
          .map(checked => ({ group: checked.name.replace(/^group:/, ''), shippingOptionId: checked.value }));
        if (selections.length < groups.length) return;
        try {
          await api(`/marketplace/carts/${state.cartId}/shipping-methods`, { method: 'POST', body: { selections } });
        } catch (error) { toast(error.message); }
        emit('route');
      }));
      bindForm($('[data-payment]', root), async values => {
        const key = storage.get('ndv-checkout-key') || `chk_${state.cartId}_${Date.now().toString(36)}`;
        storage.set('ndv-checkout-key', key);
        const result = await api(`/carts/${state.cartId}/complete`, { method: 'POST', body: { paymentMethodId: values.paymentMethodId, idempotencyKey: key } });
        storage.remove('ndv-checkout-key');
        storage.remove('ndv-cart');
        storage.set('ndv-last-order', { id: result.order.id, code: result.order.code, email: result.order.email, payment: result.payment });
        state.cartId = null;
        state.cart = null;
        emit('cart');
        navigate('/checkout/confirmado');
      });
    },
  };
}

export async function confirmation() {
  const last = storage.get('ndv-last-order');
  if (!last) {
    navigate('/', { replace: true });
    return { title: '', html: '' };
  }
  let order = null;
  if (state.me) order = await api(`/marketplace/me/orders/${last.id}`).catch(() => null);
  return {
    title: 'Pedido confirmado',
    html: `<div class="wrap page" style="max-width:720px">
      <div class="card stack" style="text-align:center">
        <div style="font-size:2.6rem" aria-hidden="true">🎉</div>
        <h1>¡Gracias por tu compra!</h1>
        <p>Tu pedido <strong>${esc(last.code)}</strong> fue registrado. ${order?.vendorOrders?.length > 1 ? `Lo preparan ${order.vendorOrders.length} tiendas.` : ''}</p>
        ${last.payment?.sessionId ? '<p class="small muted">Si elegiste transferencia, la tienda confirmará el pago al recibir el comprobante.</p>' : ''}
        <div class="btn-row" style="justify-content:center">
          ${state.me ? `<a class="btn" href="/cuenta/pedidos/${esc(last.id)}">Seguir mi pedido</a>` : '<a class="btn" href="/ingresar">Crear cuenta para seguir el pedido</a>'}
          <a class="btn ghost" href="/">Seguir comprando</a>
        </div>
        ${!state.me ? `<p class="small muted">Guardá el código <strong>${esc(last.code)}</strong>: lo necesitás para consultar el pedido con tu correo.</p>` : ''}
      </div>
    </div>`,
  };
}

/**
 * Rescate de un carrito abandonado desde el enlace firmado del recordatorio.
 * Antes este enlace no tenía pantalla y terminaba en un 404, así que el correo
 * de recuperación no servía para nada.
 */
export async function recoverCart() {
  const params = query();
  if (!params.cart || !params.t) {
    navigate('/carrito', { replace: true });
    return { title: 'Carrito', html: '' };
  }
  try {
    const recovered = await api('/carts/recover', { method: 'POST', body: { cart: params.cart, token: params.t } });
    state.cartId = recovered.id;
    storage.set('ndv-cart', recovered.id);
    await loadCart();
    toast('Recuperamos tu selección');
    navigate('/carrito', { replace: true });
    return { title: 'Carrito', html: '' };
  } catch (error) {
    return {
      title: 'Carrito',
      html: `<div class="wrap page" style="max-width:640px"><div class="card stack">
        <h1>No pudimos retomar ese carrito</h1>
        <p class="muted">${esc(error.message)}</p>
        <a class="btn" href="/">Volver a la portada</a>
      </div></div>`,
    };
  }
}
