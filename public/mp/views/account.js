/** Cuenta del comprador (y accesos a sus otras capacidades: tienda y proveedor). */
import {
  $, $$, ago, api, bindForm, date, dateTime, emit, esc, loadCart, money, navigate, prepareImage, query,
  modal, refreshMe, requireLogin, state, storage, toast,
} from '../core.js';
import { avatar, empty, formError, icon, media, productCard, stars, statusBadge, storeCard } from '../ui.js';

export async function login() {
  const back = query().volver || '/cuenta';
  if (state.me) {
    navigate(back, { replace: true });
    return { title: '', html: '' };
  }
  const mode = query().modo === 'registro' ? 'register' : 'login';
  return {
    title: mode === 'register' ? 'Crear cuenta' : 'Ingresar',
    html: `<div class="wrap page" style="max-width:460px">
      <div class="tabs"><a href="/ingresar?volver=${encodeURIComponent(back)}" aria-current="${mode === 'login' ? 'page' : 'false'}">Ingresar</a><a href="/ingresar?modo=registro&volver=${encodeURIComponent(back)}" aria-current="${mode === 'register' ? 'page' : 'false'}">Crear cuenta</a></div>
      <div class="card">
        ${mode === 'register' ? `<form data-register class="stack">${formError()}
          <div class="grid-2"><label>Nombre<input type="text" name="firstName" required autocomplete="given-name"></label><label>Apellido<input type="text" name="lastName" autocomplete="family-name"></label></div>
          <label>Correo<input type="email" name="email" required autocomplete="email"></label>
          <label>Contraseña<input type="password" name="password" required minlength="12" autocomplete="new-password"></label>
          <p class="small muted" style="margin:0">Mínimo 12 caracteres. Tu cuenta sirve para comprar, vender y participar en la comunidad.</p>
          <button class="btn block" type="submit">Crear cuenta</button></form>`
        : `<form data-login class="stack">${formError()}
          <label>Correo<input type="email" name="email" required autocomplete="email"></label>
          <label>Contraseña<input type="password" name="password" required autocomplete="current-password"></label>
          <button class="btn block" type="submit">Ingresar</button></form>`}
      </div>
      <p class="small muted" style="text-align:center;margin-top:14px">¿Sos parte del equipo de Ndivepa? <a href="/admin">Ingreso del personal</a></p>
    </div>`,
    mount(root) {
      const afterLogin = async () => {
        await refreshMe();
        if (state.cartId) {
          await api(`/carts/${state.cartId}/merge`, { method: 'POST', body: { strategy: 'combine' } })
            .then(merged => { state.cartId = merged.id; storage.set('ndv-cart', merged.id); })
            .catch(() => {});
          await loadCart();
        }
        toast(`¡Hola, ${state.me?.firstName || ''}!`);
        navigate(back, { replace: true });
      };
      bindForm($('[data-login]', root), async values => {
        await api('/customers/login', { method: 'POST', body: values });
        await afterLogin();
      });
      bindForm($('[data-register]', root), async values => {
        await api('/customers/register', { method: 'POST', body: { email: values.email, password: values.password, firstName: values.firstName, lastName: values.lastName || undefined } });
        await api('/customers/login', { method: 'POST', body: { email: values.email, password: values.password } });
        await afterLogin();
      });
    },
  };
}

const ACCOUNT_NAV = [
  ['/cuenta', 'Resumen'], ['/cuenta/pedidos', 'Pedidos'], ['/cuenta/favoritos', 'Favoritos'], ['/cuenta/siguiendo', 'Siguiendo'],
  ['/cuenta/mensajes', 'Mensajes'], ['/cuenta/avisos', 'Avisos'], ['/cuenta/resenas', 'Reseñas'],
];

function shell(active, content) {
  return `<div class="wrap page"><div class="panel">
    <nav class="side-nav" aria-label="Mi cuenta">${ACCOUNT_NAV.map(([href, label]) => `<a href="${href}" ${active === href ? 'aria-current="page"' : ''}>${label}${href === '/cuenta/avisos' && state.unread ? ` (${state.unread})` : ''}</a>`).join('')}</nav>
    <div>${content}</div></div></div>`;
}

function guard() {
  if (state.me) return null;
  requireLogin();
  return { title: '', html: '' };
}

export async function overview() {
  const blocked = guard();
  if (blocked) return blocked;
  const orders = await api('/marketplace/me/orders');
  const reviewable = await api('/community/me/reviewable');
  return {
    title: 'Mi cuenta',
    html: shell('/cuenta', `
      <div class="card"><div class="split"><div style="display:flex;gap:12px;align-items:center">${avatar({ name: `${state.me.firstName || ''} ${state.me.lastName || ''}` })}<div><h1 style="margin:0">${esc(state.me.firstName || 'Mi cuenta')}</h1><span class="small muted">${esc(state.me.email)}</span></div></div>
        <button class="btn ghost small" data-action="logout">Cerrar sesión</button></div>
        <div class="chips" style="margin-top:12px">${state.capabilities.map(capability => `<span class="badge info">${esc({ buyer: 'Comprador', seller: 'Vendedor', supplier: 'Proveedor', affiliate: 'Afiliado' }[capability] || capability)}</span>`).join('')}</div>
      </div>
      <div class="kpis" style="margin-top:12px">
        <a class="kpi" href="/cuenta/pedidos"><span>Pedidos</span><strong>${orders.count}</strong></a>
        <a class="kpi" href="/cuenta/resenas"><span>Por valorar</span><strong>${reviewable.count}</strong></a>
        <a class="kpi" href="/cuenta/avisos"><span>Avisos sin leer</span><strong>${state.unread}</strong></a>
        <a class="kpi" href="/cuenta/favoritos"><span>Favoritos</span><strong>${[...state.favorites].length}</strong></a>
      </div>
      <section class="section">
        <h2>Vender en Ndivepa</h2>
        ${state.stores.length ? `<div class="stack">${state.stores.map(store => `<a class="card split" href="/mi-tienda/${esc(store.sellerId)}"><span><strong>${esc(store.name)}</strong><br><span class="small muted">Rol: ${esc({ owner: 'Dueña/o', manager: 'Encargada/o', staff: 'Colaborador/a' }[store.role] || store.role)}</span></span>${statusBadge(store.status, store.statusLabel)}</a>`).join('')}</div>`
          : '<div class="card split"><span>Abrí tu tienda y empezá a vender a la comunidad.</span><a class="btn accent" href="/vender">Quiero vender</a></div>'}
        ${state.suppliers.length ? `<p style="margin-top:10px">${state.suppliers.map(supplier => `<a class="btn ghost small" href="/cuenta/proveedor/${esc(supplier.supplierId)}">Portal de proveedor</a>`).join(' ')}</p>` : ''}
      </section>
      <section class="section card">
        <h2>Privacidad</h2>
        <p class="small">Analítica de navegación: <strong>${state.consent === 'granted' ? 'aceptada' : 'rechazada'}</strong>. Solo se registran visitas y búsquedas si la aceptás.</p>
        <button class="btn ghost small" data-action="consent-toggle">${state.consent === 'granted' ? 'Retirar consentimiento' : 'Aceptar analítica'}</button>
      </section>`),
    mount(root) {
      $('[data-action="consent-toggle"]', root).addEventListener('click', () => {
        state.consent = state.consent === 'granted' ? 'denied' : 'granted';
        storage.set('ndv-consent', state.consent);
        api('/customers/me/consent', { method: 'POST', body: { analytics: state.consent === 'granted' } }).catch(() => {});
        emit('route');
      });
    },
  };
}

const PROGRESS = ['payment_pending', 'paid', 'preparing', 'ready_to_ship', 'shipped', 'in_transit', 'delivered'];
function progress(status) {
  const index = PROGRESS.indexOf(status === 'created' ? 'payment_pending' : status);
  return `<div class="progress" aria-hidden="true">${PROGRESS.map((_, position) => `<span class="${index >= position ? 'on' : ''}"></span>`).join('')}</div>`;
}

export async function orders() {
  const blocked = guard();
  if (blocked) return blocked;
  const result = await api('/marketplace/me/orders');
  return {
    title: 'Mis pedidos',
    html: shell('/cuenta/pedidos', `<h1>Mis pedidos</h1>${result.data.length ? `<div class="stack">${result.data.map(order => `<a class="card" href="/cuenta/pedidos/${esc(order.id)}" style="color:inherit;text-decoration:none">
      <div class="split"><strong>${esc(order.code)}</strong>${statusBadge(order.marketplaceStatus || order.status, order.marketplaceStatusLabel || order.status)}</div>
      <div class="small muted">${date(order.placedAt)} · ${order.itemCount} artículo(s) · ${order.vendorOrders.length} tienda(s)</div>
      ${progress(order.marketplaceStatus)}
      <strong>${money(order.total, order.currencyCode)}</strong></a>`).join('')}</div>` : empty('Todavía no hiciste pedidos.', { emoji: '📦', action: '<a class="btn" href="/">Empezar a comprar</a>' })}`),
  };
}

export async function orderDetail({ id }) {
  const blocked = guard();
  if (blocked) return blocked;
  const order = await api(`/marketplace/me/orders/${encodeURIComponent(id)}`);
  return {
    title: `Pedido ${order.code}`,
    html: shell('/cuenta/pedidos', `
      <a href="/cuenta/pedidos" class="small">${icon('back')} Mis pedidos</a>
      <div class="split"><h1>Pedido ${esc(order.code)}</h1>${statusBadge(order.marketplaceStatus || order.status, order.marketplaceStatusLabel)}</div>
      <p class="small muted">Realizado el ${dateTime(order.placedAt)} · Pago: ${esc({ unpaid: 'pendiente', authorized: 'pendiente de confirmación', paid: 'confirmado', partially_paid: 'parcial', refunded: 'reembolsado' }[order.paymentStatus] || order.paymentStatus)}</p>
      ${order.vendorOrders.map(vendorOrder => `<section class="card">
        <div class="split"><strong>${vendorOrder.seller ? `<a href="/tienda/${esc(vendorOrder.seller.code)}">${esc(vendorOrder.fulfilledBy)}</a>` : esc(vendorOrder.fulfilledBy)}</strong>${statusBadge(vendorOrder.status, vendorOrder.statusLabel)}</div>
        <span class="small muted">${esc(vendorOrder.code)} · ${esc({ pickup: 'Retiro en tienda', local_delivery: 'Entrega local', national_shipping: 'Envío nacional', supplier_shipping: 'Envío del proveedor' }[vendorOrder.deliveryMode] || '')}</span>
        ${progress(vendorOrder.status)}
        ${vendorOrder.items.map(item => `<div class="split small"><span>${item.quantity} × ${esc(item.title)}</span><span>${money(item.total, vendorOrder.currencyCode)}</span></div>`).join('')}
        ${vendorOrder.tracking?.trackingNumber ? `<p class="small" style="margin-top:6px">Seguimiento: <strong>${esc(vendorOrder.tracking.carrier || '')} ${esc(vendorOrder.tracking.trackingNumber)}</strong>${vendorOrder.tracking.trackingUrl ? ` · <a href="${esc(vendorOrder.tracking.trackingUrl)}" target="_blank" rel="noopener nofollow">Ver envío</a>` : ''}</p>` : ''}
        <details style="margin-top:8px"><summary class="small">Historial</summary><ul class="timeline">${vendorOrder.statusHistory.map(entry => `<li><span>${esc(entry.status)} · ${dateTime(entry.at)}${entry.note ? ` — ${esc(entry.note)}` : ''}</span></li>`).join('')}</ul></details>
        <div class="btn-row" style="margin-top:10px">
          ${vendorOrder.reviewable ? '<a class="btn small" href="/cuenta/resenas">Valorar productos</a>' : ''}
          ${vendorOrder.seller ? `<button class="btn ghost small" data-action="contact-order" data-seller="${esc(vendorOrder.seller.id)}" data-order="${esc(vendorOrder.id)}">${icon('chat')} Consultar a la tienda</button>` : ''}
          ${vendorOrder.status === 'delivered' && (order.returnable || []).some(line => vendorOrder.items.some(item => item.lineItemId === line.lineItemId))
            ? `<button class="btn ghost small" data-return="${esc(vendorOrder.id)}">Solicitar devolución</button>` : ''}
        </div>
      </section>`).join('')}
      ${(order.returns || []).length ? `<section class="card"><h2>Devoluciones</h2>${order.returns.map(record => `<div class="list-row"><div><strong>${esc(record.items.map(item => `${item.quantity} × ${item.title}`).join(', '))}</strong><div class="small muted">Solicitada ${date(record.createdAt)}${record.rejectionReason ? ` · Motivo del rechazo: ${esc(record.rejectionReason)}` : ''}${record.refundAmount ? ` · Reembolso: ${money(record.refundAmount, order.currencyCode)}` : ''}</div></div>${statusBadge(record.status, { requested: 'Solicitada', approved: 'Aprobada', rejected: 'Rechazada', received: 'Recibida', closed: 'Cerrada' }[record.status])}</div>`).join('')}</section>` : ''}
      <section class="card"><h2>Resumen</h2><div class="totals">
        <div class="row"><span>Subtotal</span><span>${money(order.subtotal, order.currencyCode)}</span></div>
        ${order.discountTotal ? `<div class="row"><span>Descuentos</span><span>−${money(order.discountTotal, order.currencyCode)}</span></div>` : ''}
        <div class="row"><span>Envío</span><span>${money(order.shippingTotal, order.currencyCode)}</span></div>
        <div class="row total"><span>Total</span><span>${money(order.total, order.currencyCode)}</span></div></div>
        <p class="small muted" style="margin-top:10px">Entrega en: ${esc([order.shippingAddress?.address1, order.shippingAddress?.city].filter(Boolean).join(', '))}</p>
      </section>`),
    mount(root) {
      $$('[data-return]', root).forEach(button => button.addEventListener('click', async () => {
        const vendorOrder = order.vendorOrders.find(row => row.id === button.dataset.return);
        const lines = (order.returnable || []).filter(line => vendorOrder.items.some(item => item.lineItemId === line.lineItemId));
        const reasons = await api('/return-reasons').then(result => result.data).catch(() => ({ data: [] }));
        modal(`<h2>Solicitar devolución</h2><p class="small muted">Elegí qué querés devolver. La tienda y la administración revisan la solicitud antes de aprobar el reembolso.</p>
          <form data-return-form class="stack">${formError()}
            ${lines.map(line => `<label class="check"><input type="checkbox" name="line" value="${esc(line.lineItemId)}" data-multi> ${esc(line.title)} (hasta ${line.quantity})
              <input type="number" min="1" max="${line.quantity}" value="${line.quantity}" data-qty="${esc(line.lineItemId)}" style="width:72px;min-height:36px;margin-left:8px"></label>`).join('')}
            <label>Motivo<select name="reasonId">${(reasons || []).map(reason => `<option value="${esc(reason.id)}">${esc(reason.label)}</option>`).join('')}</select></label>
            <label>Comentario (opcional)<textarea name="note" maxlength="600"></textarea></label>
            <div class="btn-row"><button class="btn" type="submit">Enviar solicitud</button><button class="btn ghost" type="button" data-close-btn>Cancelar</button></div>
          </form>`, {
          onMount(element, close) {
            bindForm($('[data-return-form]', element), async values => {
              const chosen = (Array.isArray(values.line) ? values.line : [values.line]).filter(Boolean);
              if (!chosen.length) throw new Error('Elegí al menos un producto.');
              const items = chosen.map(lineItemId => ({
                lineItemId,
                quantity: Number($(`[data-qty="${lineItemId}"]`, element).value || 1),
                reasonId: values.reasonId || undefined,
              }));
              await api('/returns/request', { method: 'POST', body: { orderId: order.id, items, note: values.note || undefined } });
              close();
              toast('Solicitud de devolución enviada');
              emit('route');
            });
          },
        });
      }));
      $$('[data-action="contact-order"]', root).forEach(button => button.addEventListener('click', async () => {
        const body = prompt('Escribí tu consulta sobre este pedido:');
        if (!body) return;
        try {
          const conversation = await api('/community/conversations', { method: 'POST', body: { sellerId: button.dataset.seller, vendorOrderId: button.dataset.order, body } });
          navigate(`/cuenta/mensajes/${conversation.id}`);
        } catch (error) { toast(error.message); }
      }));
    },
  };
}

export async function favorites() {
  const blocked = guard();
  if (blocked) return blocked;
  const data = await api('/community/favorites');
  return {
    title: 'Favoritos',
    html: shell('/cuenta/favoritos', `<h1>Favoritos</h1>
      ${data.products.length ? `<div class="grid">${data.products.map(item => productCard(item)).join('')}</div>` : empty('Guardá productos con ♥ para encontrarlos después.', { emoji: '💚' })}
      ${data.stores.length ? `<h2 style="margin-top:20px">Tiendas guardadas</h2><div class="stack">${data.stores.map(storeCard).join('')}</div>` : ''}`),
  };
}

export async function following() {
  const blocked = guard();
  if (blocked) return blocked;
  const data = await api('/community/following');
  return {
    title: 'Siguiendo',
    html: shell('/cuenta/siguiendo', `<h1>Siguiendo</h1>${data.stores.length ? `<div class="stack">${data.stores.map(storeCard).join('')}</div>` : empty('Seguí tiendas para ver sus novedades en la comunidad.', { emoji: '👀', action: '<a class="btn" href="/tiendas">Descubrir tiendas</a>' })}
      ${data.people.length ? `<h2 style="margin-top:18px">Personas</h2>${data.people.map(person => `<a class="card" style="display:block" href="/comunidad/perfil/${esc(person.id)}">${esc(person.name)} · <span class="small muted">${person.reviews} reseñas</span></a>`).join('')}` : ''}`),
  };
}

export async function notifications() {
  const blocked = guard();
  if (blocked) return blocked;
  const data = await api('/marketplace/me/notifications');
  if (data.data.some(item => !item.readAt)) {
    api('/marketplace/me/notifications/read', { method: 'POST', body: {} }).then(() => { state.unread = 0; emit('me'); }).catch(() => {});
  }
  return {
    title: 'Avisos',
    html: shell('/cuenta/avisos', `<h1>Avisos</h1>${data.data.length ? `<div class="card">${data.data.map(item => `<div class="list-row"><div><strong>${item.readAt ? '' : '● '}${esc(item.title)}</strong>${item.body ? `<div class="small muted">${esc(item.body)}</div>` : ''}<div class="small muted">${ago(item.createdAt)}${item.audience === 'seller' ? ' · Tienda' : item.audience === 'supplier' ? ' · Proveedor' : ''}</div></div>${item.link ? `<a class="btn ghost small" href="${esc(item.link)}">Ver</a>` : ''}</div>`).join('')}</div>` : empty('No tenés avisos.', { emoji: '🔔' })}`),
  };
}

export async function messages({ id } = {}) {
  const blocked = guard();
  if (blocked) return blocked;
  const list = await api('/community/conversations');
  let thread = null;
  if (id) thread = await api(`/community/conversations/${encodeURIComponent(id)}/messages`);
  return {
    title: 'Mensajes',
    html: shell('/cuenta/mensajes', `<h1>Mensajes</h1>
      <div class="grid-2" style="align-items:start">
        <div class="card">${list.data.map(conversation => `<a class="list-row" style="color:inherit;text-decoration:none" href="/cuenta/mensajes/${esc(conversation.id)}"><span><strong>${esc(conversation.store?.name || 'Tienda')}</strong><br><span class="small muted">${esc(conversation.subject || '')}</span><br><span class="small">${esc(conversation.lastMessagePreview || '')}</span></span>${conversation.unread ? `<span class="badge sale">${conversation.unread}</span>` : ''}</a>`).join('') || '<p class="muted">Todavía no escribiste a ninguna tienda.</p>'}</div>
        ${thread ? conversationPanel(thread, 'data-customer-send') : '<div class="card muted">Elegí una conversación.</div>'}
      </div>`),
    mount(root) {
      bindForm($('[data-customer-send]', root), async values => {
        const result = await api(`/community/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { body: values.body } });
        if (result.held) toast('Tu mensaje quedó en revisión por contener varios enlaces.');
        emit('route');
      });
    },
  };
}

export function conversationPanel(thread, attribute) {
  return `<div class="card"><div class="split"><strong>${esc(thread.conversation.subject || '')}</strong>${thread.conversation.status !== 'open' ? statusBadge(thread.conversation.status, 'Bloqueada') : ''}</div>
    <div class="thread">${thread.messages.map(message => `<div class="bubble ${message.mine ? 'mine' : ''}">${esc(message.body)}<small>${dateTime(message.createdAt)}${message.status === 'flagged' ? ' · en revisión' : ''}</small></div>`).join('') || '<p class="muted">Sin mensajes.</p>'}</div>
    ${thread.conversation.status === 'open' ? `<form ${attribute} class="stack">${formError()}<textarea name="body" required maxlength="2000" placeholder="Escribí un mensaje"></textarea><button class="btn" type="submit">Enviar</button></form>` : ''}</div>`;
}

export async function reviews() {
  const blocked = guard();
  if (blocked) return blocked;
  const pending = await api('/community/me/reviewable');
  return {
    title: 'Mis reseñas',
    html: shell('/cuenta/resenas', `<h1>Valorá tus compras</h1><p class="muted">Solo podés valorar productos que compraste y recibiste: por eso las reseñas de Ndivepa son verificadas.</p>
      ${pending.data.length ? pending.data.map(item => `<form class="card stack" data-review="${esc(item.productId)}">${formError()}
        <div style="display:grid;grid-template-columns:64px 1fr;gap:10px;align-items:center">${media({ image: item.image, name: item.name })}<div><strong>${esc(item.name)}</strong><div class="small muted">Recibido ${date(item.deliveredAt)}</div></div></div>
        <fieldset style="border:0;padding:0;margin:0"><legend class="small"><strong>Tu valoración</strong></legend><div class="chips">${[5, 4, 3, 2, 1].map(value => `<label class="chip"><input type="radio" name="rating" value="${value}" required class="sr-only">${'★'.repeat(value)}</label>`).join('')}</div></fieldset>
        <label>Título (opcional)<input type="text" name="title" maxlength="120"></label>
        <label>Comentario<textarea name="comment" maxlength="2000"></textarea></label>
        <label>Fotos (opcional, hasta 4)<input type="file" accept="image/png,image/jpeg,image/webp" multiple data-photos><span class="hint">Se reducen automáticamente antes de subirlas.</span></label>
        <button class="btn" type="submit">Publicar reseña</button></form>`).join('') : empty('No tenés compras pendientes de valorar.', { emoji: '⭐' })}`),
    mount(root) {
      $$('.chip input[type=radio]', root).forEach(input => input.addEventListener('change', () => {
        $$(`[name="rating"]`, input.form).forEach(other => other.closest('.chip').classList.toggle('active', other.checked));
      }));
      $$('[data-review]', root).forEach(form => bindForm(form, async values => {
        if (!values.rating) throw new Error('Elegí una valoración.');
        const photos = [];
        const files = [...(form.querySelector('[data-photos]').files || [])].slice(0, 4);
        for (const file of files) {
          const uploaded = await api('/community/uploads', { method: 'POST', body: { data: await prepareImage(file), alt: 'Foto de reseña' } });
          photos.push(uploaded.url);
        }
        await api('/community/reviews', { method: 'POST', body: { productId: form.dataset.review, rating: Number(values.rating), title: values.title || undefined, comment: values.comment || undefined, photos } });
        toast('¡Gracias por tu reseña!');
        emit('route');
      }));
    },
  };
}

export async function supplierPortal({ id }) {
  const blocked = guard();
  if (blocked) return blocked;
  const [orders, products] = await Promise.all([api(`/dropshipping/portal/${encodeURIComponent(id)}/orders`), api(`/dropshipping/portal/${encodeURIComponent(id)}/products`)]);
  return {
    title: 'Portal del proveedor',
    html: `<div class="wrap page"><h1>Portal del proveedor</h1>
      <section class="section"><h2>Pedidos a despachar</h2>${orders.data.length ? `<div class="stack">${orders.data.map(order => `<div class="card"><div class="split"><strong>${esc(order.code)}</strong>${statusBadge(order.status)}</div>
        ${order.items.map(item => `<div class="small">${item.quantity} × ${esc(item.title)} <span class="muted">(${esc(item.supplierSku || 's/SKU')})</span></div>`).join('')}
        <p class="small muted">Entregar a: ${esc([order.shippingAddress?.firstName, order.shippingAddress?.lastName].filter(Boolean).join(' '))}, ${esc([order.shippingAddress?.address1, order.shippingAddress?.city].filter(Boolean).join(', '))} ${esc(order.shippingAddress?.phone || '')}</p>
        ${['sent', 'accepted', 'shipped'].includes(order.status) ? `<form class="btn-row" data-supplier-order="${esc(order.id)}">${formError()}
          <select name="status" style="width:auto">${order.status === 'sent' ? '<option value="accepted">Aceptar</option>' : ''}${['sent', 'accepted'].includes(order.status) ? '<option value="shipped">Despachado</option>' : ''}${order.status === 'shipped' ? '<option value="delivered">Entregado</option>' : ''}${['sent', 'accepted'].includes(order.status) ? '<option value="cancelled">No puedo despachar</option>' : ''}</select>
          <input type="text" name="carrier" placeholder="Transportista" style="flex:1;min-width:120px"><input type="text" name="trackingNumber" placeholder="N.º de seguimiento" style="flex:1;min-width:120px">
          <button class="btn small" type="submit">Actualizar</button></form>` : order.status === 'pending' ? '<p class="small muted">Esperando que la plataforma envíe el pedido.</p>' : ''}
      </div>`).join('')}</div>` : empty('No hay pedidos pendientes.', { emoji: '📦' })}</section>
      <section class="section"><h2>Mis productos y stock</h2><div class="table-wrap"><table class="data"><thead><tr><th>Producto</th><th>SKU</th><th>Costo</th><th>Stock</th><th></th></tr></thead><tbody>
        ${products.data.map(row => `<tr><td>${esc(row.productName || row.productId)}</td><td>${esc(row.supplierSku)}</td><td>${money(row.cost, row.currencyCode)}</td><td><input type="number" min="0" value="${row.stock ?? ''}" data-stock="${esc(row.id)}" style="width:100px;min-height:36px"></td><td><button class="btn small ghost" data-save-stock="${esc(row.id)}">Guardar</button></td></tr>`).join('')}
      </tbody></table></div></section></div>`,
    mount(root) {
      $$('[data-supplier-order]', root).forEach(form => bindForm(form, async values => {
        const tracking = values.trackingNumber ? { carrier: values.carrier || undefined, trackingNumber: values.trackingNumber } : undefined;
        await api(`/dropshipping/portal/${encodeURIComponent(id)}/orders/${form.dataset.supplierOrder}/status`, { method: 'POST', body: { status: values.status, tracking } });
        toast('Pedido actualizado');
        emit('route');
      }));
      $$('[data-save-stock]', root).forEach(button => button.addEventListener('click', async () => {
        try {
          const stock = Number($(`[data-stock="${button.dataset.saveStock}"]`, root).value);
          await api(`/dropshipping/portal/${encodeURIComponent(id)}/products/${button.dataset.saveStock}`, { method: 'PATCH', body: { stock } });
          toast('Stock actualizado');
        } catch (error) { toast(error.message); }
      }));
    },
  };
}

export async function logout() {
  await api('/customers/logout', { method: 'POST', body: {} }).catch(() => {});
  await refreshMe();
  toast('Sesión cerrada');
  navigate('/');
}

export { stars };
