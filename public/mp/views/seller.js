/** Alta de vendedores y panel «Mi tienda». Toda autorización la valida el backend. */
import {
  $, $$, ago, api, bindForm, compact, date, dateTime, emit, esc, money, navigate, parseMoney,
  prepareImage, refreshMe, requireLogin, state, toast,
} from '../core.js';
import { conversationPanel } from './account.js';
import {
  categorySelect, DELIVERY_LABELS, empty, flattenCategories, formError, icon, kpi, media, priceInput, stars, statusBadge,
} from '../ui.js';

let categoriesCache = null;
async function categories() {
  if (!categoriesCache) categoriesCache = flattenCategories((await api('/marketplace/categories')).tree);
  return categoriesCache;
}

const STORE_TYPES = [['commerce', 'Comercio'], ['artisan', 'Artesano/a'], ['entrepreneur', 'Emprendimiento'], ['services', 'Servicios']];
const DAYS = [['lunes', 'Lunes'], ['martes', 'Martes'], ['miercoles', 'Miércoles'], ['jueves', 'Jueves'], ['viernes', 'Viernes'], ['sabado', 'Sábado'], ['domingo', 'Domingo']];

// --- «Quiero vender» ------------------------------------------------------------------

export async function sell() {
  const steps = ['Crear cuenta', 'Crear tienda', 'Completar información', 'Aceptar términos', 'Enviar solicitud', 'Revisión', '¡Aprobada!'];
  const intro = `<section class="hero" style="margin-top:0"><h1>Vendé en Ndivepa</h1><p>Tu tienda dentro del marketplace de la comunidad: catálogo, pedidos, reseñas y estadísticas desde el celular.</p></section>
    <ol class="steps" style="list-style:none;padding:0">${steps.map((step, index) => `<span>${index + 1}. ${step}</span>`).join('<span>›</span>')}</ol>`;
  if (!state.me) {
    return {
      title: 'Quiero vender',
      html: `<div class="wrap page" style="max-width:760px">${intro}
        <div class="card stack"><h2>Paso 1: tu cuenta</h2><p>Con una sola cuenta comprás y vendés.</p>
        <div class="btn-row"><a class="btn accent" href="/ingresar?modo=registro&volver=/vender">Crear cuenta</a><a class="btn ghost" href="/ingresar?volver=/vender">Ya tengo cuenta</a></div></div></div>`,
    };
  }
  if (state.stores.length) {
    const first = state.stores[0];
    navigate(`/mi-tienda/${first.sellerId}`, { replace: true });
    return { title: '', html: '' };
  }
  const [cats, localities] = await Promise.all([categories(), api('/marketplace/localities')]);
  const cities = localities.tree.flatMap(function walk(node) { return [node, ...node.children.flatMap(walk)]; }).filter(node => node.type === 'city' && node.launchStatus === 'active');
  return {
    title: 'Quiero vender',
    html: `<div class="wrap page" style="max-width:760px">${intro}
      <form data-create-store class="card stack">${formError()}
        <h2>Paso 2: creá tu tienda</h2>
        <label>Nombre de la tienda<input type="text" name="name" required maxlength="120" placeholder="Ej.: Hamacas Doña Rosa"></label>
        <label>Tipo<select name="type">${STORE_TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
        <label>Ciudad<select name="localityId">${cities.map(city => `<option value="${esc(city.id)}">${esc(city.name)}</option>`).join('')}</select></label>
        <fieldset style="border:0;padding:0;margin:0"><legend class="small"><strong>¿Qué vendés?</strong> (hasta 8)</legend><div class="chips" style="flex-wrap:wrap">${cats.filter(cat => cat.depth === 0).map(cat => `<label class="chip"><input type="checkbox" name="categoryIds" value="${esc(cat.id)}" data-multi> ${esc(cat.name)}</label>`).join('')}</div></fieldset>
        <button class="btn accent" type="submit">Crear tienda y continuar</button>
      </form></div>`,
    mount(root) {
      bindForm($('[data-create-store]', root), async values => {
        const store = await api('/marketplace/seller/stores', { method: 'POST', body: compact({ name: values.name, type: values.type, localityId: values.localityId, categoryIds: values.categoryIds?.length ? values.categoryIds : undefined }) });
        await refreshMe();
        toast('¡Tienda creada! Completá la información.');
        navigate(`/mi-tienda/${store.id}/configuracion`);
      });
    },
  };
}

// --- Panel ------------------------------------------------------------------------------------

const NAV = [
  ['', 'Resumen'], ['pedidos', 'Pedidos'], ['devoluciones', 'Devoluciones'], ['productos', 'Productos'], ['promociones', 'Promociones'], ['resenas', 'Reseñas'],
  ['preguntas', 'Preguntas'], ['mensajes', 'Mensajes'], ['publicaciones', 'Publicaciones'], ['publicidad', 'Publicidad'],
  ['clientes', 'Clientes'], ['configuracion', 'Configuración'],
];

async function context(sellerId) {
  if (!requireLogin('Inicia sesión para administrar tu tienda.')) return null;
  const store = await api(`/marketplace/seller/stores/${encodeURIComponent(sellerId)}`);
  return store;
}

function layout(store, active, content) {
  const base = `/mi-tienda/${store.id}`;
  const banner = store.status === 'active' ? ''
    : store.status === 'pending' && store.application?.status === 'pending' ? '<div class="notice">Tu solicitud está en revisión. Te avisaremos al aprobarla. Mientras tanto podés cargar productos como borrador.</div>'
      : store.status === 'pending' ? `<div class="notice warn">Tu tienda aún no fue enviada a revisión. <a href="${base}/configuracion">Completá la información y enviala</a>.</div>`
        : store.status === 'rejected' ? `<div class="notice warn">Tu solicitud fue rechazada: ${esc(store.statusReason || store.application?.decisionNote || '')}. Corregí y volvé a enviarla desde Configuración.</div>`
          : `<div class="notice warn">Tu tienda está suspendida: ${esc(store.statusReason || '')}.</div>`;
  return `<div class="wrap page">
    <div class="split" style="margin-bottom:10px"><div><span class="small muted">Mi tienda</span><h1 style="margin:0">${esc(store.name)}</h1></div>
      <div class="btn-row">${statusBadge(store.status, store.statusLabel)}${store.status === 'active' ? `<a class="btn ghost small" href="/tienda/${esc(store.code)}">Ver tienda pública</a>` : ''}
      ${state.stores.length > 1 ? `<select data-switch-store style="width:auto;min-height:36px">${state.stores.map(item => `<option value="${esc(item.sellerId)}" ${item.sellerId === store.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>` : ''}</div></div>
    ${banner}
    <div class="panel">
      <nav class="side-nav" aria-label="Panel de la tienda">${NAV.map(([slug, label]) => `<a href="${base}${slug ? `/${slug}` : ''}" ${active === slug ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <div>${content}</div>
    </div></div>`;
}

function mountLayout(root) {
  $('[data-switch-store]', root)?.addEventListener('change', event => navigate(`/mi-tienda/${event.target.value}`));
}

export async function sellerHome() {
  if (!requireLogin('Inicia sesión para administrar tu tienda.')) return { title: '', html: '' };
  if (!state.stores.length) {
    navigate('/vender', { replace: true });
    return { title: '', html: '' };
  }
  navigate(`/mi-tienda/${state.stores[0].sellerId}`, { replace: true });
  return { title: '', html: '' };
}

const QUALITY_LABELS = {
  sinFoto: ['Sin foto', 'Una ficha sin foto casi no se vende.'],
  sinDescripcion: ['Descripción muy corta', 'Contá medidas, materiales y qué incluye.'],
  sinStock: ['Sin stock', 'Publicada pero no se puede comprar.'],
  sinEntrega: ['Sin forma de entrega', 'El comprador no sabe cómo lo recibe.'],
  sinCategoria: ['Sin categoría', 'No aparece al navegar por categorías.'],
};

/**
 * Qué publicaciones conviene arreglar, con el producto concreto y el motivo.
 * Sale del catálogo real de la tienda, no son consejos genéricos.
 */
function qualityPanel(quality) {
  if (!quality || !quality.reviewed) return '';
  if (!quality.pending) {
    return `<section class="section card"><h2>Tus publicaciones</h2>
      <p class="small" style="color:var(--ok);margin:0">Las ${quality.reviewed} publicaciones tienen foto, descripción, stock, entrega y categoría.</p></section>`;
  }
  const blocks = Object.entries(quality.counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const [title, why] = QUALITY_LABELS[key] || [key, ''];
      const examples = (quality.issues[key] || [])
        .map(item => `<a class="chip tiny" href="/producto/${esc(item.handle)}">${esc(item.name)}</a>`).join('');
      return `<div class="split small" style="align-items:flex-start;gap:10px">
        <div><strong>${esc(title)}</strong> · ${count} producto(s)<div class="muted">${esc(why)}</div>
        <div class="signals" style="margin-top:4px">${examples}</div></div>
        <a class="btn ghost small" href="productos">Editar</a></div>`;
    }).join('<hr style="margin:10px 0;border:0;border-top:1px solid var(--line)">');
  return `<section class="section card"><h2>Mejorá tus publicaciones</h2>
    <p class="small muted" style="margin:0 0 8px">${quality.pending} detalle(s) por corregir en ${quality.reviewed} publicación(es).</p>
    ${blocks}</section>`;
}

/**
 * El catálogo de la tienda, listo para publicarlo en Facebook e Instagram, y el
 * enlace de la tienda para compartir por WhatsApp.
 */
function socialPanel(store) {
  const url = `${location.origin}/tienda/${store.code}`;
  const feed = `${location.origin}/feeds/catalogo.csv?tienda=${encodeURIComponent(store.code)}`;
  return `<section class="section card"><h2>Vendé también fuera de Ndivepa</h2>
    <p class="small muted" style="margin:0 0 8px">Compartí tu tienda donde ya están tus clientes. El enlace muestra tu foto, el precio y si hay stock.</p>
    <div class="btn-row" style="flex-wrap:wrap">
      <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`${store.name} · ${url}`)}">Compartir por WhatsApp</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">Compartir en Facebook</a>
      <a class="btn ghost" href="${esc(feed)}">Descargar catálogo (CSV)</a>
    </div>
    <p class="small muted" style="margin:8px 0 0">El CSV sirve para cargar tu catálogo en Facebook e Instagram. Se actualiza solo: siempre trae lo que tenés publicado.</p>
  </section>`;
}

export async function dashboard({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const data = await api(`/marketplace/seller/stores/${sellerId}/dashboard?days=30`);
  const currency = data.income.currencyCode;
  const statusLabels = state.config?.vendorStatuses || {};
  return {
    title: 'Mi tienda',
    html: layout(store, '', `
      <p class="small muted">Últimos ${data.range.days} días. Las vistas solo cuentan visitantes que aceptaron la analítica.</p>
      <div class="kpis">
        ${kpi('Ventas', money(data.sales.gross, currency), `${data.sales.orders} pedido(s)`)}
        ${kpi('Pedidos abiertos', data.openOrders, '<a href="pedidos">Gestionar</a>')}
        ${kpi('Productos vistos', data.views)}
        ${kpi('Conversión', data.conversionRate === null ? '—' : `${data.conversionRate}%`, 'pedidos / vistas')}
        ${kpi('Favoritos', data.favorites)}
        ${kpi('Clientes', data.buyers)}
        ${kpi('Productos', `${data.products.published}/${data.products.total}`, 'publicados')}
        ${kpi('Valoración', data.reputation.rating.average ? `${data.reputation.rating.average}★` : '—', `${data.reputation.rating.count} reseña(s)`)}
      </div>
      <section class="section"><h2>Ingresos</h2><div class="kpis">
        ${kpi('Disponible para liquidar', money(data.income.available, currency), 'Entregado y confirmado')}
        ${kpi('Pendiente', money(data.income.pending, currency), 'Pedidos en curso')}
        ${kpi('Liquidado', money(data.income.paid, currency))}
        ${kpi('Comisiones de la plataforma', money(data.income.commissions.confirmed + data.income.commissions.pending, currency), 'Según reglas vigentes')}
      </div></section>
      <div class="grid-2">
        <section class="card"><h2>Pedidos por estado</h2>${Object.entries(data.ordersByStatus).map(([status, count]) => `<div class="split small">${statusBadge(status, statusLabels[status] || status)}<strong>${count}</strong></div>`).join('') || '<p class="muted">Sin pedidos todavía.</p>'}</section>
        <section class="card"><h2>Más vendidos</h2>${data.topProducts.map(row => `<div class="split small"><span>${esc(row.title)}</span><span>${row.units} u · ${money(row.revenue, currency)}</span></div>`).join('') || '<p class="muted">Aún no hay ventas.</p>'}</section>
      </div>
      ${qualityPanel(data.quality)}
      ${socialPanel(store)}
      <section class="section card"><h2>Reputación</h2><div class="rep-grid">
        <div class="rep"><strong>${data.reputation.salesCount}</strong><span>ventas entregadas</span></div>
        <div class="rep"><strong>${data.reputation.fulfillmentRate === null ? '—' : `${data.reputation.fulfillmentRate}%`}</strong><span>cumplimiento</span></div>
        <div class="rep"><strong>${data.reputation.responseTimeHours === null ? '—' : `${data.reputation.responseTimeHours} h`}</strong><span>respuesta a preguntas</span></div>
        <div class="rep"><strong>${data.reputation.incidents}</strong><span>incidencias</span></div>
      </div></section>`),
    mount: mountLayout,
  };
}

// --- Pedidos -------------------------------------------------------------------------------------

const TRANSITION_LABELS = {
  preparing: 'Empezar a preparar', ready_to_ship: 'Listo para envío/retiro', shipped: 'Marcar enviado', in_transit: 'En tránsito',
  delivered: 'Marcar entregado', cancelled: 'Cancelar',
};

export async function orders({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const filter = new URLSearchParams(location.search).get('estado') || '';
  const result = await api(`/marketplace/seller/stores/${sellerId}/orders${filter ? `?status=${filter}` : ''}`);
  const labels = state.config?.vendorStatuses || {};
  return {
    title: 'Pedidos',
    html: layout(store, 'pedidos', `
      <div class="chips" style="margin-bottom:12px">${[['', 'Todos'], ['payment_pending', 'Pago pendiente'], ['paid', 'Pagados'], ['preparing', 'En preparación'], ['ready_to_ship', 'Listos'], ['shipped', 'Enviados'], ['delivered', 'Entregados'], ['cancelled', 'Cancelados']]
        .map(([value, label]) => `<a class="chip ${filter === value ? 'active' : ''}" href="?estado=${value}">${label}</a>`).join('')}</div>
      ${result.data.length ? `<div class="stack">${result.data.map(order => `<a class="card" style="color:inherit;text-decoration:none" href="/mi-tienda/${esc(sellerId)}/pedidos/${esc(order.id)}">
        <div class="split"><strong>${esc(order.code)}</strong>${statusBadge(order.status, order.statusLabel)}</div>
        <div class="small muted">${dateTime(order.placedAt)} · ${esc(order.buyer.name)} · ${esc(DELIVERY_LABELS[order.deliveryMode] || '')}</div>
        <div class="split small"><span>${order.items.map(item => `${item.quantity}× ${esc(item.title)}`).join(', ')}</span><strong>${money(order.total, order.currencyCode)}</strong></div>
      </a>`).join('')}</div>` : empty(`No hay pedidos${filter ? ` en estado «${labels[filter] || filter}»` : ''}.`, { emoji: '📦' })}`),
    mount: mountLayout,
  };
}

export async function orderDetail({ sellerId, orderId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const order = await api(`/marketplace/seller/stores/${sellerId}/orders/${orderId}`);
  const currency = order.currencyCode;
  return {
    title: `Pedido ${order.code}`,
    html: layout(store, 'pedidos', `
      <a class="small" href="/mi-tienda/${esc(sellerId)}/pedidos">${icon('back')} Pedidos</a>
      <div class="split"><h2>Pedido ${esc(order.code)}</h2>${statusBadge(order.status, order.statusLabel)}</div>
      <div class="grid-2" style="align-items:start">
        <section class="card">
          <h3>Productos</h3>
          ${order.items.map(item => `<div class="split small"><span>${item.quantity} × ${esc(item.title)}${item.variantTitle && item.variantTitle !== 'Estándar' ? ` (${esc(item.variantTitle)})` : ''}</span><span>${money(item.total, currency)}</span></div>`).join('')}
          <hr><div class="totals small">
            <div class="row"><span>Subtotal</span><span>${money(order.subtotal, currency)}</span></div>
            ${order.sellerDiscountTotal ? `<div class="row"><span>Descuentos de tu tienda</span><span>−${money(order.sellerDiscountTotal, currency)}</span></div>` : ''}
            ${order.shippingShare ? `<div class="row"><span>Envío</span><span>${money(order.shippingShare, currency)}</span></div>` : ''}
            <div class="row"><span>Comisión de la plataforma</span><span>−${money(order.commissionTotal, currency)}</span></div>
            <div class="row total"><span>Recibís</span><span>${money(order.sellerPayout, currency)}</span></div>
          </div>
          <p class="small muted">Comisión según regla: ${esc(order.items[0]?.commissionRule?.name || '—')} (${order.items[0]?.commissionRule?.percent ?? 0}%).</p>
        </section>
        <section class="card stack">
          <h3>Entrega</h3>
          <p class="small" style="margin:0"><strong>${esc(DELIVERY_LABELS[order.deliveryMode] || '')}</strong>${order.shippingMethodName ? ` · ${esc(order.shippingMethodName)}` : ''}</p>
          <p class="small" style="margin:0">Cliente: <strong>${esc(order.buyer.name)}</strong>${order.buyer.phone ? ` · ${esc(order.buyer.phone)}` : ''}</p>
          ${order.buyer.address ? `<p class="small" style="margin:0">${esc([order.buyer.address.address1, order.buyer.address.address2, order.buyer.address.city].filter(Boolean).join(', '))}${order.buyer.address.instructions ? `<br><em>${esc(order.buyer.address.instructions)}</em>` : ''}</p>` : ''}
          ${order.note ? `<p class="small">Nota: ${esc(order.note)}</p>` : ''}
          <p class="small muted" style="margin:0">Pago: ${esc({ cash_on_delivery: 'Contra entrega', manual_transfer: 'Transferencia', in_store: 'En tienda' }[order.paymentProvider] || order.paymentProvider || '—')}</p>
          ${order.allowedTransitions.length ? `<form data-status class="stack">${formError()}
            ${order.allowedTransitions.includes('shipped') ? `<div class="grid-2"><input type="text" name="carrier" placeholder="Transportista (opcional)"><input type="text" name="trackingNumber" placeholder="N.º de seguimiento (opcional)"></div>` : ''}
            <input type="text" name="note" placeholder="Nota (opcional; obligatoria para cancelar)" maxlength="300">
            <div class="btn-row">${order.allowedTransitions.map(status => `<button class="btn ${status === 'cancelled' ? 'ghost' : ''} small" type="submit" name="status" value="${status}">${TRANSITION_LABELS[status] || status}</button>`).join('')}</div>
          </form>` : '<p class="small muted">No hay acciones pendientes.</p>'}
          <details><summary class="small">Historial</summary><ul class="timeline">${order.statusHistory.map(entry => `<li><span>${esc(state.config?.vendorStatuses?.[entry.status] || entry.status)} · ${dateTime(entry.at)}${entry.note ? ` — ${esc(entry.note)}` : ''}</span></li>`).join('')}</ul></details>
        </section>
      </div>`),
    mount(root) {
      mountLayout(root);
      const form = $('[data-status]', root);
      if (!form) return;
      let chosen = null;
      $$('button[name="status"]', form).forEach(button => button.addEventListener('click', () => { chosen = button.value; }));
      bindForm(form, async values => {
        if (chosen === 'cancelled' && !values.note) throw new Error('Indicá el motivo de la cancelación.');
        if (chosen === 'cancelled' && !confirm('¿Cancelar este pedido? Quedará registrado como incidencia de la tienda.')) return;
        const tracking = values.trackingNumber ? compact({ carrier: values.carrier, trackingNumber: values.trackingNumber }) : undefined;
        await api(`/marketplace/seller/stores/${sellerId}/orders/${orderId}/status`, { method: 'POST', body: compact({ status: chosen, note: values.note, tracking }) });
        toast('Pedido actualizado');
        emit('route');
      });
    },
  };
}

export async function returns({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const result = await api(`/marketplace/seller/stores/${sellerId}/returns`);
  return {
    title: 'Devoluciones',
    html: layout(store, 'devoluciones', `<h2>Devoluciones</h2>
      <p class="small muted">La administración aprueba y reembolsa; acá ves el estado y qué producto vuelve. Si regresa en buen estado, el stock se repone en tu tienda.</p>
      ${result.data.length ? `<div class="stack">${result.data.map(record => `<div class="card">
        <div class="split"><strong>${esc(record.vendorOrderCode || '')}</strong>${statusBadge(record.status, { requested: 'Solicitada', approved: 'Aprobada', rejected: 'Rechazada', received: 'Recibida', closed: 'Cerrada' }[record.status])}</div>
        <div class="small">${record.items.map(item => `${item.quantity} × ${esc(item.title)}${item.condition ? ` (${esc(item.condition)})` : ''}`).join(', ')}</div>
        <div class="small muted">Solicitada ${date(record.createdAt)}${record.note ? ` · ${esc(record.note)}` : ''}${record.refundAmount ? ` · Reembolso: ${money(record.refundAmount, record.currencyCode)}` : ''}${record.rejectionReason ? ` · Rechazo: ${esc(record.rejectionReason)}` : ''}</div>
      </div>`).join('')}</div>` : empty('No hay devoluciones.', { emoji: '📭' })}`),
    mount: mountLayout,
  };
}
// --- Productos ------------------------------------------------------------------------------

export async function products({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const result = await api(`/marketplace/seller/stores/${sellerId}/products`);
  return {
    title: 'Productos',
    html: layout(store, 'productos', `
      <div class="split" style="margin-bottom:12px"><h2 style="margin:0">Productos (${result.count})</h2><div class="btn-row"><a class="btn ghost small" href="/mi-tienda/${esc(sellerId)}/productos/importar">Importar CSV</a><a class="btn small" href="/mi-tienda/${esc(sellerId)}/productos/nuevo">+ Nuevo producto</a></div></div>
      ${result.data.length ? `<div class="stack">${result.data.map(product => `<a class="card" style="display:grid;grid-template-columns:64px 1fr;gap:12px;color:inherit;text-decoration:none" href="/mi-tienda/${esc(sellerId)}/productos/${esc(product.id)}">
        ${media({ image: product.images[0]?.url, name: product.name })}
        <div><div class="split"><strong>${esc(product.name)}</strong>${statusBadge(product.status, { draft: 'Borrador', proposed: 'En revisión', published: 'Publicado', rejected: 'Rechazado' }[product.status])}</div>
        <div class="small muted">${money(product.price?.amount, product.price?.currency)} · Stock: ${product.variants.map(variant => (variant.stock === null ? '∞' : variant.stock)).join(' / ')} · ${product.viewCount} vistas</div></div></a>`).join('')}</div>`
        : empty('Todavía no cargaste productos.', { emoji: '🧺', action: `<a class="btn" href="/mi-tienda/${esc(sellerId)}/productos/nuevo">Cargar el primero</a>` })}`),
    mount: mountLayout,
  };
}

export async function productForm({ sellerId, productId = null }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const [cats, product] = await Promise.all([categories(), productId ? api(`/marketplace/seller/stores/${sellerId}/products/${productId}`) : null]);
  const variant = product?.variants?.[0];
  const images = (product?.images || []).filter(image => image.id).map(image => ({ id: image.id, url: image.url }));
  const modes = new Set(product?.deliveryModes?.length ? product.deliveryModes : store.deliveryModes || []);
  return {
    title: product ? product.name : 'Nuevo producto',
    html: layout(store, 'productos', `
      <a class="small" href="/mi-tienda/${esc(sellerId)}/productos">${icon('back')} Productos</a>
      <div class="split"><h2>${product ? 'Editar producto' : 'Nuevo producto'}</h2>${product ? statusBadge(product.status, { draft: 'Borrador', proposed: 'En revisión', published: 'Publicado', rejected: 'Rechazado' }[product.status]) : ''}</div>
      <form data-product class="card stack">${formError()}
        <label>Nombre<input type="text" name="name" required maxlength="200" value="${esc(product?.name || '')}" placeholder="Ej.: Hamaca de poyvi doble"></label>
        <label>Descripción<textarea name="description" maxlength="20000" placeholder="Materiales, medidas, cuidados, tiempos de elaboración…">${esc(product?.description || '')}</textarea></label>
        <div class="grid-2"><label>Categoría${categorySelect(cats, product?.categoryId || '')}</label><label>Marca (opcional)<input type="text" name="brand" value="${esc(product?.brand || '')}"></label></div>
        <label>Etiquetas (separadas por coma)<input type="text" name="tags" value="${esc((product?.tags || []).join(', '))}" placeholder="hamaca, poyvi, artesanal"></label>
        <div class="grid-2">
          <label>Precio (Gs.)${priceInput('price', variant?.price ?? product?.price?.amount, { required: true, placeholder: '150000' })}</label>
          <label>Precio anterior (opcional)${priceInput('compareAtPrice', variant?.compareAtPrice)}</label>
        </div>
        <div class="grid-2">
          <label>Stock (vacío = sin control)<input type="number" name="stock" min="0" value="${variant?.stock ?? ''}"></label>
          <label>SKU (opcional)<input type="text" name="sku" value="${esc(variant?.sku || '')}" ${product ? 'disabled' : ''}></label>
        </div>
        <div class="grid-2">
          <label>Peso (g)<input type="number" name="weight" min="0" step="1"></label>
          <label>Días de preparación<input type="number" name="handlingDays" min="0" max="90" value="${product?.shippingInfo?.handlingDays ?? ''}"></label>
        </div>
        <fieldset style="border:0;padding:0;margin:0"><legend class="small"><strong>Formas de entrega</strong></legend>
          ${['pickup', 'local_delivery', 'national_shipping'].map(mode => `<label class="check"><input type="checkbox" name="deliveryModes" value="${mode}" data-multi ${modes.has(mode) ? 'checked' : ''}> ${DELIVERY_LABELS[mode]}</label>`).join('')}</fieldset>
        <div><strong class="small">Fotos</strong><div class="upload-grid" data-images style="margin:6px 0">${images.map(image => `<span class="thumb" data-image="${esc(image.id)}"><img src="${esc(image.url)}" alt=""><button type="button" data-remove-image="${esc(image.id)}" aria-label="Quitar">×</button></span>`).join('')}</div>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple data-upload><div class="hint small muted">PNG, JPEG o WebP. Las fotos grandes se reducen en tu teléfono antes de subirse; la primera es la principal.</div></div>
        <div class="btn-row">
          <button class="btn" type="submit" name="intent" value="save">${product ? 'Guardar cambios' : 'Guardar borrador'}</button>
          ${!product || product.status !== 'published' ? `<button class="btn accent" type="submit" name="intent" value="publish" ${store.status !== 'active' ? 'disabled title="La tienda debe estar aprobada"' : ''}>Publicar</button>` : '<button class="btn ghost" type="button" data-unpublish>Despublicar</button>'}
          ${product ? '<button class="btn ghost" type="button" data-delete>Eliminar</button>' : ''}
        </div>
      </form>`),
    mount(root) {
      mountLayout(root);
      const assetIds = images.map(image => image.id);
      const renderImages = () => {
        $('[data-images]', root).innerHTML = assetIds.map(id => {
          const url = root.querySelector(`[data-image="${id}"] img`)?.src || imageUrls.get(id);
          return `<span class="thumb" data-image="${esc(id)}"><img src="${esc(url)}" alt=""><button type="button" data-remove-image="${esc(id)}" aria-label="Quitar">×</button></span>`;
        }).join('');
      };
      const imageUrls = new Map(images.map(image => [image.id, image.url]));
      root.addEventListener('click', event => {
        const remove = event.target.closest('[data-remove-image]');
        if (!remove) return;
        assetIds.splice(assetIds.indexOf(remove.dataset.removeImage), 1);
        renderImages();
      });
      $('[data-upload]', root).addEventListener('change', async event => {
        for (const file of [...event.target.files].slice(0, 8 - assetIds.length)) {
          try {
            const uploaded = await api(`/marketplace/seller/stores/${sellerId}/uploads`, { method: 'POST', body: { data: await prepareImage(file), alt: $('[name="name"]', root).value || store.name } });
            imageUrls.set(uploaded.id, uploaded.url);
            if (!assetIds.includes(uploaded.id)) assetIds.push(uploaded.id);
            renderImages();
          } catch (error) { toast(error.message); }
        }
        event.target.value = '';
      });
      let intent = 'save';
      $$('[name="intent"]', root).forEach(button => button.addEventListener('click', () => { intent = button.value; }));
      bindForm($('[data-product]', root), async values => {
        const payload = compact({
          name: values.name,
          description: values.description,
          categoryId: values.categoryId,
          brand: values.brand,
          tags: values.tags ? values.tags.split(',').map(tag => tag.trim()).filter(Boolean) : undefined,
          price: parseMoney(values.price),
          compareAtPrice: values.compareAtPrice ? parseMoney(values.compareAtPrice) : undefined,
          stock: values.stock === '' ? undefined : Number(values.stock),
          sku: product ? undefined : values.sku || undefined,
          weight: values.weight ? Number(values.weight) : undefined,
          deliveryModes: values.deliveryModes,
          shippingInfo: values.handlingDays ? { handlingDays: Number(values.handlingDays) } : undefined,
          assetIds,
        });
        let saved;
        if (product) {
          saved = await api(`/marketplace/seller/stores/${sellerId}/products/${product.id}`, { method: 'PATCH', body: payload });
          if (intent === 'publish') saved = await api(`/marketplace/seller/stores/${sellerId}/products/${product.id}/publish`, { method: 'POST', body: {} });
        } else {
          saved = await api(`/marketplace/seller/stores/${sellerId}/products`, { method: 'POST', body: { ...payload, status: intent === 'publish' ? 'published' : 'draft' } });
        }
        toast(saved.status === 'published' ? 'Producto publicado' : saved.status === 'proposed' ? 'Enviado a revisión' : 'Guardado');
        navigate(`/mi-tienda/${sellerId}/productos/${saved.id}`, { replace: true });
      });
      $('[data-unpublish]', root)?.addEventListener('click', async () => {
        await api(`/marketplace/seller/stores/${sellerId}/products/${product.id}/unpublish`, { method: 'POST', body: {} });
        toast('Producto retirado del catálogo');
        emit('route');
      });
      $('[data-delete]', root)?.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este producto?')) return;
        try {
          await api(`/marketplace/seller/stores/${sellerId}/products/${product.id}`, { method: 'DELETE' });
          navigate(`/mi-tienda/${sellerId}/productos`);
        } catch (error) { toast(error.message); }
      });
    },
  };
}

export async function importProducts({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const sample = 'name,description,category,price,compare_at_price,sku,stock,brand,tags,weight_g,delivery_modes\nHamaca de poyvi,Hecha a mano,poyvi,350000,,,5,,hamaca;poyvi,1800,pickup;local_delivery';
  return {
    title: 'Importar productos',
    html: layout(store, 'productos', `
      <a class="small" href="/mi-tienda/${esc(sellerId)}/productos">${icon('back')} Productos</a>
      <h2>Importar desde CSV</h2>
      <p class="small muted">Columnas obligatorias: <code>name</code>, <code>category</code> (nombre o handle) y <code>price</code> en guaraníes. Primero se valida sin guardar: duplicados de SKU, nombres repetidos, categorías desconocidas y datos incompletos.</p>
      <form data-import class="card stack">${formError()}
        <label>Contenido CSV<textarea name="csv" rows="10" required>${esc(sample)}</textarea></label>
        <label class="check"><input type="checkbox" name="publish"> Publicar directamente (la tienda debe estar aprobada)</label>
        <div class="btn-row"><button class="btn ghost" type="submit" name="mode" value="check">Validar</button><button class="btn" type="submit" name="mode" value="import">Importar</button></div>
      </form>
      <div data-report></div>`),
    mount(root) {
      mountLayout(root);
      let mode = 'check';
      $$('[name="mode"]', root).forEach(button => button.addEventListener('click', () => { mode = button.value; }));
      bindForm($('[data-import]', root), async values => {
        const report = await api(`/marketplace/seller/stores/${sellerId}/products/import`, { method: 'POST', body: { csv: values.csv, dryRun: mode === 'check', publish: Boolean(values.publish) } });
        $('[data-report]', root).innerHTML = `<div class="card"><p><strong>${report.dryRun ? 'Validación' : 'Importación'}:</strong> ${report.valid} válida(s), ${report.created} creada(s), ${report.skipped} con problemas.</p>
          <div class="table-wrap"><table class="data"><thead><tr><th>Línea</th><th>Producto</th><th>Resultado</th></tr></thead><tbody>${report.rows.map(row => `<tr><td>${row.line}</td><td>${esc(row.name || '')}</td><td>${row.status === 'error' ? `<span style="color:var(--danger)">${esc(row.issues.join(' · '))}</span>` : esc({ valid: 'Válida', created: 'Creada' }[row.status] || row.status)}</td></tr>`).join('')}</tbody></table></div></div>`;
      });
    },
  };
}

// --- Promociones -------------------------------------------------------------------------------

export async function promotions({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const result = await api(`/marketplace/seller/stores/${sellerId}/promotions`);
  return {
    title: 'Promociones',
    html: layout(store, 'promociones', `
      <h2>Promociones</h2>
      <p class="small muted">Las promociones de tu tienda se aplican solo a tus productos y las financia tu tienda. La comisión se calcula sobre el importe con descuento.</p>
      <form data-promo class="card stack">${formError()}
        <div class="grid-2"><label>Nombre<input type="text" name="name" required maxlength="140" placeholder="Semana del poyvi"></label><label>Texto visible<input type="text" name="label" maxlength="80" placeholder="20% en hamacas"></label></div>
        <div class="grid-2"><label>Tipo<select name="type"><option value="percentage">Porcentaje</option><option value="fixed">Monto fijo (Gs.)</option></select></label><label>Valor<input type="number" name="value" min="1" required></label></div>
        <div class="grid-2"><label>Código de cupón (opcional)<input type="text" name="code" maxlength="30" pattern="[A-Za-z0-9-]{3,30}" placeholder="Vacío = automática"></label><label>Usos máximos (opcional)<input type="number" name="usageLimit" min="1"></label></div>
        <div class="grid-2"><label>Desde<input type="date" name="startsAt"></label><label>Hasta<input type="date" name="endsAt"></label></div>
        <button class="btn" type="submit" ${store.status !== 'active' ? 'disabled' : ''}>Crear promoción</button>
      </form>
      <div class="stack" style="margin-top:12px">${result.data.map(promo => `<div class="card split"><div><strong>${esc(promo.name)}</strong> ${statusBadge(promo.status)}<div class="small muted">${promo.applicationMethod.type === 'percentage' ? `${promo.applicationMethod.value}%` : money(promo.applicationMethod.value)} · ${promo.coupons.length ? `Cupón ${promo.coupons.map(coupon => esc(coupon.code)).join(', ')}` : 'Automática'} · usada ${promo.usageCount || 0} vez/veces${promo.endsAt ? ` · hasta ${date(promo.endsAt)}` : ''}</div></div>
        <button class="btn ghost small" data-toggle-promo="${esc(promo.id)}" data-next="${promo.status === 'active' ? 'paused' : 'active'}">${promo.status === 'active' ? 'Pausar' : 'Activar'}</button></div>`).join('')}</div>`),
    mount(root) {
      mountLayout(root);
      bindForm($('[data-promo]', root), async values => {
        await api(`/marketplace/seller/stores/${sellerId}/promotions`, {
          method: 'POST',
          body: compact({
            name: values.name, label: values.label, type: values.type, value: Number(values.value), code: values.code,
            usageLimit: values.usageLimit ? Number(values.usageLimit) : undefined,
            startsAt: values.startsAt ? new Date(`${values.startsAt}T00:00:00`).toISOString() : undefined,
            endsAt: values.endsAt ? new Date(`${values.endsAt}T23:59:59`).toISOString() : undefined,
          }),
        });
        toast('Promoción creada');
        emit('route');
      });
      $$('[data-toggle-promo]', root).forEach(button => button.addEventListener('click', async () => {
        await api(`/marketplace/seller/stores/${sellerId}/promotions/${button.dataset.togglePromo}/status`, { method: 'POST', body: { status: button.dataset.next } });
        emit('route');
      }));
    },
  };
}

// --- Reseñas, preguntas, mensajes y publicaciones ----------------------------------------------------

export async function reviews({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const result = await api(`/community/seller/${sellerId}/reviews`);
  return {
    title: 'Reseñas',
    html: layout(store, 'resenas', `<h2>Reseñas</h2>${result.data.length ? `<div class="card">${result.data.map(review => `<div class="review">
      <div class="split"><strong>${esc(review.productName || '')}</strong><span class="small muted">${date(review.createdAt)}</span></div>
      ${stars({ average: review.rating, count: 1 }, { showCount: false })} <span class="small">${esc(review.author)}</span> ${review.verifiedPurchase ? '<span class="badge ok">Compra verificada</span>' : ''} ${review.status !== 'published' ? statusBadge(review.status) : ''}
      <p>${esc(review.comment || '')}</p>
      ${review.sellerReply ? `<div class="reply"><strong>Tu respuesta:</strong> ${esc(review.sellerReply.body)}</div>` : `<form class="btn-row" data-reply="${esc(review.id)}">${formError()}<input type="text" name="body" required maxlength="1000" placeholder="Responder públicamente" style="flex:1"><button class="btn small" type="submit">Responder</button></form>`}
    </div>`).join('')}</div>` : empty('Todavía no hay reseñas.', { emoji: '⭐' })}`),
    mount(root) {
      mountLayout(root);
      $$('[data-reply]', root).forEach(form => bindForm(form, async values => {
        await api(`/community/seller/${sellerId}/reviews/${form.dataset.reply}/reply`, { method: 'POST', body: { body: values.body } });
        emit('route');
      }));
    },
  };
}

export async function questions({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const result = await api(`/community/seller/${sellerId}/questions`);
  return {
    title: 'Preguntas',
    html: layout(store, 'preguntas', `<h2>Preguntas</h2><p class="small muted">Responder rápido mejora tu reputación: el tiempo de respuesta se muestra en tu tienda.</p>
      ${result.data.length ? `<div class="card">${result.data.map(question => `<div class="review"><div class="small muted">${esc(question.productName || '')} · ${ago(question.createdAt)}</div><p><strong>${esc(question.body)}</strong></p>
        ${question.answer?.body ? `<div class="reply">${esc(question.answer.body)}</div>` : `<form class="btn-row" data-answer="${esc(question.id)}">${formError()}<input type="text" name="body" required maxlength="1000" placeholder="Tu respuesta pública" style="flex:1"><button class="btn small" type="submit">Responder</button></form>`}</div>`).join('')}</div>` : empty('No hay preguntas.', { emoji: '❓' })}`),
    mount(root) {
      mountLayout(root);
      $$('[data-answer]', root).forEach(form => bindForm(form, async values => {
        await api(`/community/seller/${sellerId}/questions/${form.dataset.answer}/answer`, { method: 'POST', body: { body: values.body } });
        emit('route');
      }));
    },
  };
}

export async function messages({ sellerId, conversationId = null }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const list = await api(`/community/seller/${sellerId}/conversations`);
  const thread = conversationId ? await api(`/community/seller/${sellerId}/conversations/${conversationId}/messages`) : null;
  return {
    title: 'Mensajes',
    html: layout(store, 'mensajes', `<h2>Mensajes de clientes</h2><div class="grid-2" style="align-items:start">
      <div class="card">${list.data.map(conversation => `<a class="list-row" style="color:inherit;text-decoration:none" href="/mi-tienda/${esc(sellerId)}/mensajes/${esc(conversation.id)}"><span><strong>${esc(conversation.customerName)}</strong><br><span class="small muted">${esc(conversation.subject || '')}</span><br><span class="small">${esc(conversation.lastMessagePreview || '')}</span></span>${conversation.unread ? `<span class="badge sale">${conversation.unread}</span>` : ''}</a>`).join('') || '<p class="muted">Sin consultas.</p>'}</div>
      ${thread ? conversationPanel(thread, 'data-seller-send') : '<div class="card muted">Elegí una conversación.</div>'}</div>`),
    mount(root) {
      mountLayout(root);
      bindForm($('[data-seller-send]', root), async values => {
        const result = await api(`/community/seller/${sellerId}/conversations/${conversationId}/messages`, { method: 'POST', body: { body: values.body } });
        if (result.held) toast('Tu mensaje quedó en revisión por contener varios enlaces.');
        emit('route');
      });
    },
  };
}

export async function posts({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const [result, productsResult] = await Promise.all([api(`/community/seller/${sellerId}/posts`), api(`/marketplace/seller/stores/${sellerId}/products?status=published`)]);
  return {
    title: 'Publicaciones',
    html: layout(store, 'publicaciones', `<h2>Publicaciones</h2><p class="small muted">Contá novedades a tus seguidores: aparecen en el feed de la comunidad.</p>
      <form data-post class="card stack">${formError()}
        <label>Tipo<select name="type"><option value="update">Novedad</option><option value="offer">Oferta</option><option value="new_product">Nuevo producto</option><option value="event">Evento</option></select></label>
        <label>Texto<textarea name="body" required maxlength="1500"></textarea></label>
        ${productsResult.data.length ? `<fieldset style="border:0;padding:0;margin:0"><legend class="small"><strong>Etiquetar productos</strong></legend>${productsResult.data.slice(0, 20).map(product => `<label class="check"><input type="checkbox" name="productIds" value="${esc(product.id)}" data-multi> ${esc(product.name)}</label>`).join('')}</fieldset>` : ''}
        <label>Imagen (opcional)<input type="file" accept="image/png,image/jpeg,image/webp" data-post-image></label>
        <button class="btn" type="submit" ${store.status !== 'active' ? 'disabled' : ''}>Publicar</button>
      </form>
      <div class="stack" style="margin-top:12px">${result.data.map(post => `<div class="card"><div class="split">${statusBadge(post.status)}<span class="small muted">${ago(post.createdAt)} · ♥ ${post.likeCount}</span></div><p style="white-space:pre-wrap">${esc(post.body)}</p>${post.status === 'published' ? `<button class="btn ghost small" data-hide-post="${esc(post.id)}">Retirar</button>` : ''}</div>`).join('')}</div>`),
    mount(root) {
      mountLayout(root);
      bindForm($('[data-post]', root), async values => {
        let imageUrl;
        const file = $('[data-post-image]', root).files[0];
        if (file) imageUrl = (await api(`/marketplace/seller/stores/${sellerId}/uploads`, { method: 'POST', body: { data: await prepareImage(file), alt: store.name } })).url;
        await api(`/community/seller/${sellerId}/posts`, { method: 'POST', body: compact({ type: values.type, body: values.body, productIds: values.productIds?.length ? values.productIds : undefined, imageUrl }) });
        toast('Publicado en la comunidad');
        emit('route');
      });
      $$('[data-hide-post]', root).forEach(button => button.addEventListener('click', async () => {
        await api(`/community/seller/${sellerId}/posts/${button.dataset.hidePost}`, { method: 'DELETE' });
        emit('route');
      }));
    },
  };
}

// --- Publicidad y clientes -------------------------------------------------------------------------

const AD_TYPES = { featured_product: 'Producto destacado', featured_store: 'Tienda destacada', banner: 'Banner', promoted_position: 'Posición promocionada' };
const AD_PLACEMENTS = { home: 'Portada', search: 'Búsqueda', category: 'Categoría', feed: 'Comunidad' };

export async function ads({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const [result, productsResult] = await Promise.all([api(`/marketplace/seller/stores/${sellerId}/ads`), api(`/marketplace/seller/stores/${sellerId}/products?status=published`)]);
  return {
    title: 'Publicidad',
    html: layout(store, 'publicidad', `<h2>Publicidad</h2>
      <p class="small muted">Los anuncios se muestran siempre marcados como «Patrocinado» y separados de los resultados normales. Cada solicitud la revisa y cobra la administración antes de publicarse.</p>
      <form data-ad class="card stack">${formError()}
        <div class="grid-2"><label>Tipo<select name="type">${Object.entries(AD_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label>Ubicación<select name="placement">${Object.entries(AD_PLACEMENTS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label></div>
        <label>Producto<select name="productId"><option value="">— (para tienda o banner)</option>${productsResult.data.map(product => `<option value="${esc(product.id)}">${esc(product.name)}</option>`).join('')}</select></label>
        <label>Título<input type="text" name="title" required maxlength="120"></label>
        <label>Palabras clave (búsqueda, separadas por coma)<input type="text" name="keywords"></label>
        <div class="grid-2"><label>Desde<input type="date" name="startsAt" required></label><label>Hasta<input type="date" name="endsAt" required></label></div>
        <label>Monto propuesto (Gs., tarifa fija)${priceInput('rate', null, { required: true })}</label>
        <button class="btn" type="submit" ${store.status !== 'active' ? 'disabled' : ''}>Solicitar anuncio</button>
      </form>
      <div class="table-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>Anuncio</th><th>Estado</th><th>Pago</th><th>Impresiones</th><th>Clics</th><th>CTR</th><th></th></tr></thead><tbody>
        ${result.data.map(ad => `<tr><td>${esc(ad.title)}<div class="small muted">${AD_TYPES[ad.type]} · ${AD_PLACEMENTS[ad.placement] || ad.placement}</div></td><td>${statusBadge(ad.status)}${ad.live ? ' <span class="badge ok">En línea</span>' : ''}</td><td>${statusBadge(ad.paymentStatus)}</td><td>${ad.impressions}</td><td>${ad.clicks}</td><td>${ad.ctr ?? '—'}${ad.ctr !== null ? '%' : ''}</td>
          <td>${['approved', 'paused'].includes(ad.status) ? `<button class="btn ghost small" data-pause="${esc(ad.id)}" data-paused="${ad.status === 'approved'}">${ad.status === 'approved' ? 'Pausar' : 'Reanudar'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin anuncios.</td></tr>'}
      </tbody></table></div>`),
    mount(root) {
      mountLayout(root);
      bindForm($('[data-ad]', root), async values => {
        await api(`/marketplace/seller/stores/${sellerId}/ads`, {
          method: 'POST',
          body: compact({
            type: values.type, placement: values.placement, productId: values.productId, title: values.title,
            keywords: values.keywords ? values.keywords.split(',').map(word => word.trim()).filter(Boolean) : undefined,
            startsAt: new Date(`${values.startsAt}T00:00:00`).toISOString(), endsAt: new Date(`${values.endsAt}T23:59:59`).toISOString(),
            pricingModel: 'flat', rate: parseMoney(values.rate),
          }),
        });
        toast('Solicitud enviada a revisión');
        emit('route');
      });
      $$('[data-pause]', root).forEach(button => button.addEventListener('click', async () => {
        await api(`/marketplace/seller/stores/${sellerId}/ads/${button.dataset.pause}/pause`, { method: 'POST', body: { paused: button.dataset.paused === 'true' } });
        emit('route');
      }));
    },
  };
}

export async function customers({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const result = await api(`/marketplace/seller/stores/${sellerId}/customers`);
  return {
    title: 'Clientes',
    html: layout(store, 'clientes', `<h2>Clientes</h2><p class="small muted">Por privacidad solo ves el nombre visible y el historial con tu tienda.</p>
      ${result.data.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Cliente</th><th>Pedidos</th><th>Total</th><th>Último</th></tr></thead><tbody>${result.data.map(row => `<tr><td>${esc(row.name)}</td><td>${row.orders}</td><td>${money(row.total)}</td><td>${date(row.lastOrderAt)}</td></tr>`).join('')}</tbody></table></div>` : empty('Aún no hay clientes.', { emoji: '🤝' })}`),
    mount: mountLayout,
  };
}

// --- Configuración y envío a revisión -------------------------------------------------------------------

export async function settings({ sellerId }) {
  const store = await context(sellerId);
  if (!store) return { title: '', html: '' };
  const [cats, localities] = await Promise.all([categories(), api('/marketplace/localities')]);
  const cities = localities.tree.flatMap(function walk(node) { return [node, ...node.children.flatMap(walk)]; }).filter(node => node.type === 'city' && node.launchStatus !== 'hidden');
  const city = cities.find(item => item.id === store.localityId);
  const hours = new Map((store.hours || []).map(hour => [hour.day, hour]));
  const selectedCats = new Set(store.categoryIds || []);
  const canSubmit = ['pending', 'rejected'].includes(store.status) && store.application?.status !== 'pending';
  return {
    title: 'Configuración',
    html: layout(store, 'configuracion', `
      ${canSubmit ? `<section class="card stack" style="margin-bottom:12px"><h2>Enviar a revisión</h2>
        <ul class="checklist">${store.checklist.items.map(item => `<li class="${item.ok ? 'ok' : ''}">${esc(item.label)}</li>`).join('')}</ul>
        <form data-submit class="stack">${formError()}<label class="check"><input type="checkbox" name="acceptTerms" required> Acepto los términos para vendedores (versión ${esc(state.config?.marketplace?.sellerTermsVersion || '')}): vender productos legales y propios, describirlos con veracidad, cumplir entregas y respetar a la comunidad.</label>
        <button class="btn accent" type="submit" ${store.checklist.complete ? '' : 'disabled'}>Enviar solicitud</button></form></section>` : ''}
      <form data-profile class="card stack">${formError()}
        <h2>Perfil público</h2>
        <div class="grid-2"><label>Nombre<input type="text" name="name" required maxlength="120" value="${esc(store.name)}"></label>
          <label>Tipo<select name="type">${STORE_TYPES.map(([value, label]) => `<option value="${value}" ${store.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
        <label>Frase corta<input type="text" name="tagline" maxlength="160" value="${esc(store.tagline || '')}"></label>
        <label>Descripción<textarea name="description" maxlength="3000" placeholder="Contá tu historia, qué hacés y cómo trabajás (mínimo 40 caracteres).">${esc(store.description || '')}</textarea></label>
        <div><strong class="small">Logo</strong><div style="display:flex;gap:10px;align-items:center;margin-top:6px">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt="" style="width:56px;height:56px;border-radius:14px;object-fit:cover">` : ''}<input type="file" accept="image/png,image/jpeg,image/webp" data-logo></div></div>
        <fieldset style="border:0;padding:0;margin:0"><legend class="small"><strong>Categorías</strong></legend><div class="chips" style="flex-wrap:wrap">${cats.filter(cat => cat.depth === 0).map(cat => `<label class="chip"><input type="checkbox" name="categoryIds" value="${esc(cat.id)}" data-multi ${selectedCats.has(cat.id) ? 'checked' : ''}> ${esc(cat.name)}</label>`).join('')}</div></fieldset>
        <h2>Ubicación</h2>
        <div class="grid-2"><label>Ciudad<select name="localityId">${cities.map(item => `<option value="${esc(item.id)}" ${item.id === store.localityId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
          <label>Zona general<select name="area"><option value="">Elegí</option>${(city?.areas || []).map(area => `<option ${store.location?.area === area ? 'selected' : ''}>${esc(area)}</option>`).join('')}</select></label></div>
        <label>Dirección (privada: solo para la administración)<input type="text" name="address" maxlength="200" value="${esc(store.location?.address || '')}"></label>
        <label class="check"><input type="checkbox" name="public" ${store.location?.public ? 'checked' : ''}> Mostrar mi ubicación exacta en el mapa</label>
        <div class="grid-2"><label>Latitud<input type="text" inputmode="decimal" name="lat" value="${store.location?.lat ?? ''}"></label><label>Longitud<input type="text" inputmode="decimal" name="lng" value="${store.location?.lng ?? ''}"></label></div>
        <button type="button" class="btn ghost small" data-geolocate>${icon('pin')} Usar mi ubicación actual</button>
        <h2>Entrega y horarios</h2>
        ${['pickup', 'local_delivery', 'national_shipping'].map(mode => `<label class="check"><input type="checkbox" name="deliveryModes" value="${mode}" data-multi ${(store.deliveryModes || []).includes(mode) ? 'checked' : ''}> ${DELIVERY_LABELS[mode]}</label>`).join('')}
        <div class="table-wrap"><table class="data"><tbody>${DAYS.map(([day, label]) => { const hour = hours.get(day) || {}; return `<tr><th>${label}</th><td><input type="time" name="opens_${day}" value="${esc(hour.opens || '')}"></td><td><input type="time" name="closes_${day}" value="${esc(hour.closes || '')}"></td><td><label class="check small"><input type="checkbox" name="closed_${day}" ${hour.closed ? 'checked' : ''}> Cerrado</label></td></tr>`; }).join('')}</tbody></table></div>
        <h2>Contacto y redes</h2>
        <div class="grid-2"><label>Teléfono de contacto (privado)<input type="tel" name="contactPhone" value="${esc(store.contactPhone || '')}"></label><label>Correo comercial (privado)<input type="email" name="contactEmail" value="${esc(store.contactEmail || '')}"></label></div>
        <div class="grid-2"><label>WhatsApp (público)<input type="tel" name="whatsapp" value="${esc(store.social?.whatsapp || '')}"></label><label>Instagram<input type="text" name="instagram" value="${esc(store.social?.instagram || '')}"></label></div>
        <div class="grid-2"><label>Facebook<input type="text" name="facebook" value="${esc(store.social?.facebook || '')}"></label><label>TikTok<input type="text" name="tiktok" value="${esc(store.social?.tiktok || '')}"></label></div>
        <h2>Datos comerciales</h2>
        <div class="grid-2"><label>Razón social (privada)<input type="text" name="legalName" value="${esc(store.legalName || '')}"></label><label>RUC (privado)<input type="text" name="taxId" value="${esc(store.taxId || '')}"></label></div>
        <label>Información comercial pública (cambios, garantías, facturación)<textarea name="businessInfo" maxlength="1000">${esc(store.businessInfo || '')}</textarea></label>
        <button class="btn" type="submit">Guardar</button>
      </form>
      <form data-member class="card stack" style="margin-top:12px">${formError()}<h2>Equipo</h2><p class="small muted">Sumá a alguien con cuenta en Ndivepa para que te ayude con pedidos y productos.</p>
        <div class="grid-2"><label>Correo<input type="email" name="email" required></label><label>Rol<select name="role"><option value="staff">Colaborador/a</option><option value="manager">Encargado/a</option></select></label></div>
        <button class="btn ghost" type="submit">Agregar</button></form>`),
    mount(root) {
      mountLayout(root);
      bindForm($('[data-submit]', root), async () => {
        await api(`/marketplace/seller/stores/${sellerId}/submit`, { method: 'POST', body: { acceptTerms: true } });
        await refreshMe();
        toast('Solicitud enviada. Te avisaremos cuando la revisemos.');
        emit('route');
      });
      $('[data-geolocate]', root)?.addEventListener('click', () => {
        if (!navigator.geolocation) return toast('Tu navegador no permite obtener la ubicación.');
        navigator.geolocation.getCurrentPosition(position => {
          $('[name="lat"]', root).value = position.coords.latitude.toFixed(5);
          $('[name="lng"]', root).value = position.coords.longitude.toFixed(5);
        }, () => toast('No se pudo obtener la ubicación.'));
        return null;
      });
      bindForm($('[data-profile]', root), async (values, form) => {
        let logoUrl;
        const file = $('[data-logo]', form).files[0];
        if (file) logoUrl = (await api(`/marketplace/seller/stores/${sellerId}/uploads`, { method: 'POST', body: { data: await prepareImage(file), alt: `Logo de ${values.name}` } })).url;
        const hoursPayload = DAYS.map(([day]) => ({ day, opens: values[`opens_${day}`] || undefined, closes: values[`closes_${day}`] || undefined, closed: Boolean(values[`closed_${day}`]) }))
          .filter(hour => hour.closed || hour.opens || hour.closes)
          .map(hour => compact(hour));
        const lat = values.lat === '' ? undefined : Number(values.lat.replace(',', '.'));
        const lng = values.lng === '' ? undefined : Number(values.lng.replace(',', '.'));
        await api(`/marketplace/seller/stores/${sellerId}`, {
          method: 'PATCH',
          body: compact({
            name: values.name, type: values.type, tagline: values.tagline, description: values.description, logoUrl,
            categoryIds: values.categoryIds, localityId: values.localityId,
            location: compact({ area: values.area, address: values.address, public: values.public, lat, lng }),
            deliveryModes: values.deliveryModes, hours: hoursPayload,
            contactPhone: values.contactPhone, contactEmail: values.contactEmail, legalName: values.legalName, taxId: values.taxId, businessInfo: values.businessInfo,
            social: compact({ whatsapp: values.whatsapp, instagram: values.instagram, facebook: values.facebook, tiktok: values.tiktok }),
          }),
        });
        await refreshMe();
        toast('Perfil guardado');
        emit('route');
      });
      bindForm($('[data-member]', root), async values => {
        await api(`/marketplace/seller/stores/${sellerId}/members`, { method: 'POST', body: values });
        toast('Miembro agregado');
      });
    },
  };
}
