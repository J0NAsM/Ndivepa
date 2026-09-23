/**
 * Panel administrativo del marketplace (personal con RBAC).
 * Cada acción depende de un permiso validado en el servidor; la interfaz solo
 * oculta lo que el usuario no puede hacer, no lo protege.
 */
import { $, $$, ago, api, bindForm, compact, date, dateTime, emit, esc, money, navigate, parseMoney, state, toast } from '../core.js';
import { categorySelect, empty, flattenCategories, formError, kpi, statusBadge } from '../ui.js';

const admin = (path, options = {}) => api(path, { ...options, base: 'admin' });

const SECTIONS = [
  ['', 'Resumen', 'marketplace:read'], ['vendedores', 'Vendedores', 'seller:read'], ['productos', 'Productos', 'product:read'],
  ['pedidos', 'Pedidos', 'order:read'], ['devoluciones', 'Devoluciones', 'return:read'], ['liquidaciones', 'Liquidaciones', 'sellerPayout:read'], ['comisiones', 'Comisiones', 'commissionRule:read'],
  ['categorias', 'Categorías', 'category:read'], ['localidades', 'Localidades', 'locality:read'], ['proveedores', 'Dropshipping', 'supplier:read'],
  ['afiliados', 'Afiliados', 'commission:read'], ['publicidad', 'Publicidad', 'adCampaign:read'], ['moderacion', 'Moderación', 'report:read'],
  ['analitica', 'Analítica', 'analytics:read'], ['busqueda', 'Búsqueda', 'searchSynonym:read'], ['avisos', 'Avisos', 'inboxNotification:read'], ['configuracion', 'Configuración', 'settings:read'],
];

function can(permission) {
  const granted = new Set(state.staff?.permissions || []);
  if (granted.has('*')) return true;
  const [resource, action] = permission.split(':');
  return granted.has(permission) || granted.has(`${resource}:*`) || granted.has(`${resource}:manage`);
}

async function ensureStaff() {
  if (state.staff) return true;
  const me = await api('/api/auth/me', { base: 'root' }).catch(() => null);
  if (me?.user) {
    state.staff = { ...me.user, permissions: me.permissions || [] };
    return true;
  }
  return false;
}

function loginView() {
  return {
    title: 'Administración',
    html: `<div class="wrap page" style="max-width:420px"><h1>Ingreso del personal</h1><p class="muted small">Acceso para administración y moderación. Las cuentas de compradores y vendedores ingresan <a href="/ingresar">aquí</a>.</p>
      <form data-staff-login class="card stack">${formError()}<label>Correo<input type="email" name="email" required autocomplete="username"></label><label>Contraseña<input type="password" name="password" required autocomplete="current-password"></label><label>Código 2FA (si lo activaste)<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"></label><button class="btn block" type="submit">Ingresar</button></form></div>`,
    mount(root) {
      bindForm($('[data-staff-login]', root), async values => {
        await api('/api/auth/login', { base: 'root', method: 'POST', body: compact(values) });
        state.staff = null;
        await ensureStaff();
        emit('route');
      });
    },
  };
}

function layout(active, content) {
  return `<div class="wrap page">
    <div class="split" style="margin-bottom:10px"><div><span class="small muted">Administración</span><h1 style="margin:0">${esc(SECTIONS.find(([slug]) => slug === active)?.[1] || '')}</h1></div>
      <div class="btn-row"><span class="small muted">${esc(state.staff.name || state.staff.email)}</span><a class="btn ghost small" href="/panel.html">Panel de afiliación clásico</a><button class="btn ghost small" data-staff-logout>Salir</button></div></div>
    <div class="panel"><nav class="side-nav" aria-label="Administración">${SECTIONS.filter(([, , permission]) => can(permission)).map(([slug, label]) => `<a href="/admin${slug ? `/${slug}` : ''}" ${active === slug ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav><div>${content}</div></div></div>`;
}

function mountLayout(root) {
  $('[data-staff-logout]', root)?.addEventListener('click', async () => {
    await api('/api/auth/logout', { base: 'root', method: 'POST', body: {} }).catch(() => {});
    state.staff = null;
    navigate('/admin');
  });
}

/** Punto de entrada: resuelve la sección y exige sesión de personal. */
export async function adminRoute({ section = '', id = null } = {}) {
  if (!(await ensureStaff())) return loginView();
  const handler = HANDLERS[section];
  if (!handler) return { title: 'Administración', html: layout(section, empty('Sección desconocida.')), mount: mountLayout };
  const view = await handler({ id });
  return { title: view.title, html: layout(section, view.html), mount(root) { mountLayout(root); view.mount?.(root); } };
}

const table = (headers, rows) => `<div class="table-wrap"><table class="data"><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}" class="muted">Sin registros.</td></tr>`}</tbody></table></div>`;
const refresh = () => emit('route');
const act = handler => async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await handler(button.dataset);
    refresh();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
};

/** Comisiones de afiliados por moneda: cada programa informa en la suya. */
function affiliateKpis(revenue) {
  const entries = Object.entries(revenue.byCurrency || {});
  if (!entries.length) return '<p class="muted small">Sin comisiones de afiliados registradas.</p>';
  return entries.map(([currency, totals]) => `<div class="kpis" style="margin-bottom:8px">
    <div class="kpi stream accent"><span>Pendientes (no son ingreso)</span><strong>${money(totals.pending, currency)}</strong></div>
    <div class="kpi stream accent"><span>Aprobadas</span><strong>${money(totals.approved, currency)}</strong></div>
    <div class="kpi stream accent"><span>Pagadas (ingreso)</span><strong>${money(totals.paid, currency)}</strong></div>
    <div class="kpi stream accent"><span>Rechazadas</span><strong>${money(totals.rejected, currency)}</strong></div></div>`).join('');
}

// --- Resumen ------------------------------------------------------------------------------

async function overview() {
  const data = await admin('/marketplace/dashboard');
  const currency = data.currencyCode;
  const m = value => money(value, currency);
  const pr = data.platformRevenue;
  return {
    title: 'Resumen',
    html: `
      <div class="notice small">Cada flujo se informa por separado: las ventas del marketplace no son ingresos de la plataforma, y una comisión de afiliado pendiente no es un ingreso.</div>
      <div class="kpis">
        ${kpi('Pedidos', data.orders.total, `${data.orders.vendorOrders} subpedidos · ${data.orders.cancelled} cancelados`)}
        ${kpi('Unidades vendidas', data.unitsSold)}
        ${kpi('Vendedores activos', data.sellers.active, `${data.sellers.pending} pendientes · ${data.sellers.suspended} suspendidos`)}
        ${kpi('Compradores', data.buyers)}
        ${kpi('Productos publicados', data.products.published, Object.entries(data.products.byModel).map(([model, count]) => `${model}: ${count}`).join(' · '))}
        ${kpi('Solicitudes pendientes', data.pendingApplications, '<a href="/admin/vendedores">Revisar</a>')}
        ${kpi('Reportes abiertos', data.openReports, '<a href="/admin/moderacion">Moderar</a>')}
        ${kpi('Avisos sin leer', data.unreadInbox, '<a href="/admin/avisos">Ver</a>')}
      </div>
      <section class="section"><h2>Ventas del marketplace (GMV)</h2><div class="kpis">
        <div class="kpi stream">${`<span>Confirmadas (entregadas)</span><strong>${m(data.marketplaceSales.confirmed)}</strong>`}</div>
        <div class="kpi stream">${`<span>En curso</span><strong>${m(data.marketplaceSales.pending)}</strong>`}</div>
        <div class="kpi stream">${`<span>Anuladas</span><strong>${m(data.marketplaceSales.reversed)}</strong>`}</div>
      </div></section>
      <section class="section"><h2>Ingresos de la plataforma</h2><div class="kpis">
        <div class="kpi stream ok"><span>Comisiones</span><strong>${m(pr.commissions.confirmed)}</strong><small>+ ${m(pr.commissions.pending)} pendiente</small></div>
        <div class="kpi stream ok"><span>Productos propios</span><strong>${m(pr.ownSales.confirmed)}</strong><small>+ ${m(pr.ownSales.pending)} pendiente</small></div>
        <div class="kpi stream ok"><span>Publicidad</span><strong>${m(pr.advertising.confirmed)}</strong></div>
        <div class="kpi stream ok"><span>Suscripciones</span><strong>${m(pr.subscriptions.confirmed)}</strong></div>
        <div class="kpi stream warn"><span>Descuentos a cargo de la plataforma</span><strong>${m(pr.platformDiscounts.confirmed + pr.platformDiscounts.pending)}</strong></div>
      </div></section>
      <section class="section"><h2>Ingresos de afiliados</h2>${affiliateKpis(data.affiliateRevenue)}<p class="small muted">${esc(data.affiliateRevenue.note)} Detalle en <a href="/admin/afiliados">Afiliados</a>.</p></section>
      <section class="section"><h2>Margen de dropshipping</h2><div class="kpis">
        <div class="kpi stream warn"><span>Margen confirmado</span><strong>${m(data.dropshipping.margin.confirmed)}</strong><small>+ ${m(data.dropshipping.margin.pending)} pendiente</small></div>
        <div class="kpi stream warn"><span>Costo de proveedores</span><strong>${m(data.dropshipping.supplierCost.confirmed + data.dropshipping.supplierCost.pending)}</strong></div>
      </div></section>
      <section class="section"><div class="split"><h2 style="margin:0">Exportar</h2><span class="small muted">CSV con importes en unidades mínimas y su moneda</span></div>
        <div class="btn-row" style="margin-top:8px">${['pedidos', 'contabilidad', 'liquidaciones', 'productos', 'tiendas'].map(dataset => `<a class="btn ghost small" href="/api/v1/admin/marketplace/exports/${dataset}">${dataset[0].toUpperCase()}${dataset.slice(1)}</a>`).join('')}</div></section>
      <section class="section"><h2>A pagar a tiendas</h2><div class="kpis">
        ${kpi('Pendiente (pedidos en curso)', m(data.sellerPayable.pending))}${kpi('Confirmado sin liquidar', m(data.sellerPayable.confirmedUnpaid), '<a href="/admin/liquidaciones">Liquidar</a>')}${kpi('Liquidado', m(data.sellerPayable.paid))}
      </div></section>`,
  };
}

// --- Vendedores ----------------------------------------------------------------------------

async function sellers() {
  const status = new URLSearchParams(location.search).get('estado') || '';
  const [result, plans] = await Promise.all([admin(`/marketplace/sellers${status ? `?status=${status}` : ''}`), admin('/seller-plans')]);
  return {
    title: 'Vendedores',
    html: `<div class="chips" style="margin-bottom:12px">${[['', 'Todas'], ['pending', 'Pendientes'], ['active', 'Aprobadas'], ['rejected', 'Rechazadas'], ['suspended', 'Suspendidas']].map(([value, label]) => `<a class="chip ${status === value ? 'active' : ''}" href="?estado=${value}">${label}</a>`).join('')}</div>
      <div class="stack">${result.data.map(seller => `<div class="card stack">
        <div class="split"><div><strong>${esc(seller.name)}</strong> ${statusBadge(seller.status, seller.statusLabel)}<div class="small muted">${esc(seller.code)} · ${esc(seller.contactEmail || '')} · ${esc(seller.contactPhone || '')} · alta ${date(seller.createdAt)}</div></div>
          ${seller.status === 'active' ? `<a class="btn ghost small" href="/tienda/${esc(seller.code)}">Ver tienda</a>` : ''}</div>
        <div class="small">${esc(seller.description || 'Sin descripción')}</div>
        <div class="small muted">Zona: ${esc(seller.location?.area || '—')} · Dirección (privada): ${esc(seller.location?.address || '—')} · RUC: ${esc(seller.taxId || '—')} · Ventas: ${seller.reputation.salesCount} · Cumplimiento: ${seller.reputation.fulfillmentRate ?? '—'}${seller.reputation.fulfillmentRate !== null ? '%' : ''} · Incidencias: ${seller.reputation.incidents}</div>
        ${seller.application ? `<div class="small">Solicitud: ${statusBadge(seller.application.status)} ${seller.application.submittedAt ? `enviada ${dateTime(seller.application.submittedAt)}` : ''} ${seller.application.decisionNote ? `· ${esc(seller.application.decisionNote)}` : ''}</div>` : ''}
        <ul class="checklist small">${seller.checklist.items.map(item => `<li class="${item.ok ? 'ok' : ''}">${esc(item.label)}</li>`).join('')}</ul>
        <div class="btn-row">
          ${seller.application?.status === 'pending' ? `<button class="btn small" data-decide="${esc(seller.application.id)}" data-decision="approve">Aprobar</button><button class="btn ghost small" data-decide="${esc(seller.application.id)}" data-decision="reject">Rechazar</button>` : ''}
          ${seller.status === 'active' ? `<button class="btn ghost small" data-suspend="${esc(seller.id)}">Suspender</button>` : ''}
          ${seller.status === 'suspended' ? `<button class="btn small" data-reactivate="${esc(seller.id)}">Reactivar</button>` : ''}
          <select data-plan="${esc(seller.id)}" style="width:auto;min-height:36px"><option value="">Sin plan</option>${plans.data.map(plan => `<option value="${esc(plan.id)}" ${seller.planId === plan.id ? 'selected' : ''}>Plan ${esc(plan.name)}</option>`).join('')}</select>
        </div></div>`).join('') || empty('No hay tiendas en este estado.')}</div>`,
    mount(root) {
      $$('[data-decide]', root).forEach(button => button.addEventListener('click', act(async data => {
        const note = data.decision === 'reject' ? prompt('Motivo del rechazo (se envía a la tienda):') : prompt('Nota opcional:') || undefined;
        if (data.decision === 'reject' && !note) throw new Error('El rechazo necesita un motivo.');
        await admin(`/marketplace/seller-applications/${data.decide}/decision`, { method: 'POST', body: compact({ decision: data.decision, note }) });
      })));
      $$('[data-suspend]', root).forEach(button => button.addEventListener('click', act(async data => {
        const reason = prompt('Motivo de la suspensión:');
        if (!reason) throw new Error('Indica un motivo.');
        await admin(`/marketplace/sellers/${data.suspend}/status`, { method: 'POST', body: { action: 'suspend', reason } });
      })));
      $$('[data-reactivate]', root).forEach(button => button.addEventListener('click', act(data => admin(`/marketplace/sellers/${data.reactivate}/status`, { method: 'POST', body: { action: 'reactivate' } }))));
      $$('[data-plan]', root).forEach(select => select.addEventListener('change', async () => {
        try {
          await admin(`/marketplace/sellers/${select.dataset.plan}/plan`, { method: 'POST', body: compact({ planId: select.value }) });
          toast('Plan actualizado');
        } catch (error) { toast(error.message); }
      }));
    },
  };
}

// --- Productos ----------------------------------------------------------------------------

async function products() {
  const params = new URLSearchParams(location.search);
  const search = new URLSearchParams(compact({ status: params.get('estado') || '', model: params.get('modelo') || '', q: params.get('q') || '' }));
  const [result, tree, suppliers] = await Promise.all([admin(`/marketplace/products?${search}`), api('/marketplace/categories'), admin('/suppliers?filter[status]=active')]);
  const cats = flattenCategories(tree.tree);
  return {
    title: 'Productos',
    html: `<form data-filter class="btn-row" style="margin-bottom:12px"><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Buscar" style="flex:1;min-width:140px">
        <select name="estado" style="width:auto"><option value="">Estado</option>${['draft', 'proposed', 'published', 'rejected'].map(value => `<option ${params.get('estado') === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
        <select name="modelo" style="width:auto"><option value="">Modelo</option>${['LOCAL', 'PROPIO', 'DROPSHIPPING', 'AFILIADO'].map(value => `<option ${params.get('modelo') === value ? 'selected' : ''}>${value}</option>`).join('')}</select><button class="btn small" type="submit">Filtrar</button></form>
      ${table(['Producto', 'Modelo', 'Tienda / origen', 'Precio', 'Estado', ''], result.data.map(product => `<tr><td><a href="/producto/${esc(product.handle)}">${esc(product.name)}</a>${product.visible ? '' : ' <span class="badge warn">No visible</span>'}</td><td>${esc(product.commercialModel)}</td><td>${esc(product.seller?.name || product.merchantName || 'Ndivepa')}</td><td>${money(product.price.amount, product.price.currency)}</td><td>${statusBadge(product.status)}</td>
        <td class="nowrap">${product.status !== 'published' ? `<button class="btn small" data-moderate="${esc(product.id)}" data-decision="publish">Publicar</button>` : `<button class="btn ghost small" data-moderate="${esc(product.id)}" data-decision="unpublish">Retirar</button>`} ${product.status === 'proposed' ? `<button class="btn ghost small" data-moderate="${esc(product.id)}" data-decision="reject">Rechazar</button>` : ''}</td></tr>`))}
      <details class="card" style="margin-top:14px"><summary><strong>Cargar producto propio o de dropshipping</strong></summary>
        <form data-listing class="stack" style="margin-top:10px">${formError()}
          <label>Origen<select name="supplierId"><option value="">Producto propio (Ndivepa)</option>${suppliers.data.map(supplier => `<option value="${esc(supplier.id)}">Dropshipping: ${esc(supplier.name)}</option>`).join('')}</select></label>
          <label>Nombre<input type="text" name="name" required></label><label>Descripción<textarea name="description"></textarea></label>
          <label>Categoría${categorySelect(cats)}</label>
          <div class="grid-2"><label>Precio (Gs.)<input type="text" name="price" inputmode="numeric" required></label><label>Stock<input type="number" name="stock" min="0"></label></div>
          <div class="grid-2"><label>SKU del proveedor (dropshipping)<input type="text" name="supplierSku"></label><label>Costo del proveedor (Gs.)<input type="text" name="cost" inputmode="numeric"></label></div>
          <label class="check"><input type="checkbox" name="publish"> Publicar</label>
          <button class="btn" type="submit">Crear</button></form></details>`,
    mount(root) {
      bindForm($('[data-filter]', root), values => navigate(`/admin/productos?${new URLSearchParams(compact(values))}`));
      $$('[data-moderate]', root).forEach(button => button.addEventListener('click', act(async data => {
        const note = data.decision === 'publish' ? undefined : prompt('Nota para la tienda (opcional):') || undefined;
        await admin(`/marketplace/products/${data.moderate}/moderate`, { method: 'POST', body: compact({ decision: data.decision, note }) });
      })));
      bindForm($('[data-listing]', root), async values => {
        const base = compact({ name: values.name, description: values.description, categoryId: values.categoryId, price: parseMoney(values.price), stock: values.stock === '' ? undefined : Number(values.stock), status: values.publish ? 'published' : 'draft' });
        if (values.supplierId) {
          if (!values.supplierSku || !values.cost) throw new Error('Para dropshipping indicá SKU y costo del proveedor.');
          await admin('/dropshipping/products', { method: 'POST', body: { ...base, supplierId: values.supplierId, supplierSku: values.supplierSku, cost: parseMoney(values.cost) } });
        } else {
          await admin('/marketplace/listings', { method: 'POST', body: base });
        }
        toast('Producto creado');
        refresh();
      });
    },
  };
}

// --- Pedidos ------------------------------------------------------------------------------------

const ADMIN_TARGETS = ['paid', 'preparing', 'ready_to_ship', 'shipped', 'in_transit', 'delivered', 'cancelled', 'returned'];

async function orders() {
  const q = new URLSearchParams(location.search).get('codigo') || '';
  const result = await admin(`/marketplace/orders${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const labels = state.config?.vendorStatuses || {};
  const payments = await Promise.all(result.data.slice(0, 40).map(order => admin(`/payments?filter[orderId]=${order.id}`).then(response => [order.id, response.data]).catch(() => [order.id, []])));
  const paymentsByOrder = new Map(payments);
  return {
    title: 'Pedidos',
    html: `<form data-search class="btn-row" style="margin-bottom:12px"><input type="search" name="codigo" value="${esc(q)}" placeholder="Código o correo" style="flex:1"><button class="btn small" type="submit">Buscar</button></form>
      <div class="stack">${result.data.map(order => `<div class="card stack">
        <div class="split"><strong>${esc(order.code)}</strong><span>${statusBadge(order.marketplaceStatus || order.status, order.marketplaceStatusLabel || order.status)} ${statusBadge(order.paymentStatus)}</span></div>
        <div class="small muted">${dateTime(order.placedAt)} · ${esc(order.email || '')} · ${money(order.total, order.currencyCode)}</div>
        ${(paymentsByOrder.get(order.id) || []).map(payment => `<div class="split small"><span>Pago ${esc(payment.provider)} · ${money(payment.amount, payment.currencyCode)} · ${statusBadge(payment.status)}</span>${['authorized', 'partially_captured'].includes(payment.status) ? `<button class="btn small" data-capture="${esc(payment.id)}">Registrar cobro</button>` : ''}${payment.capturedAmount > (payment.refundedAmount || 0) ? ` <button class="btn ghost small" data-refund="${esc(payment.id)}" data-max="${payment.capturedAmount - (payment.refundedAmount || 0)}">Reembolsar</button>` : ''}</div>`).join('')}
        ${order.vendorOrders.map(vendorOrder => `<div class="list-row"><span><strong>${esc(vendorOrder.code)}</strong> · ${esc(vendorOrder.partyType)} · ${money(vendorOrder.total, vendorOrder.currencyCode)} · comisión ${money(vendorOrder.commissionTotal, vendorOrder.currencyCode)} ${statusBadge(vendorOrder.status, vendorOrder.statusLabel)}</span>
          <span class="btn-row"><select data-vo-target="${esc(vendorOrder.id)}" style="width:auto;min-height:36px"><option value="">Cambiar estado…</option>${ADMIN_TARGETS.map(target => `<option value="${target}">${esc(labels[target] || target)}</option>`).join('')}</select></span></div>`).join('')}
      </div>`).join('') || empty('No hay pedidos.')}</div>`,
    mount(root) {
      bindForm($('[data-search]', root), values => navigate(`/admin/pedidos?codigo=${encodeURIComponent(values.codigo)}`));
      $('[data-capture]', root).forEach(button => button.addEventListener('click', act(data => admin(`/payments/${data.capture}/capture`, { method: 'POST', body: {} }))));
      $('[data-refund]', root).forEach(button => button.addEventListener('click', act(async data => {
        const amount = parseMoney(prompt('Importe a reembolsar (Gs.):', data.max));
        if (!amount) return;
        const reason = prompt('Motivo del reembolso:') || 'Reembolso al comprador';
        await admin(`/payments/${data.refund}/refund`, { method: 'POST', body: { amount, reason } });
      })));
      $$('[data-vo-target]', root).forEach(select => select.addEventListener('change', async () => {
        if (!select.value) return;
        const note = prompt('Nota (opcional):') || undefined;
        try {
          await admin(`/marketplace/vendor-orders/${select.dataset.voTarget}/status`, { method: 'POST', body: compact({ status: select.value, note }) });
          toast('Subpedido actualizado');
          refresh();
        } catch (error) {
          toast(error.message);
          select.value = '';
        }
      }));
    },
  };
}

/** Devoluciones y reembolsos: aprobar, rechazar, recibir con inspección y cerrar el dinero. */
async function returnsView() {
  const [list, reasons, refunds] = await Promise.all([
    admin('/returns?order=-createdAt&limit=100'),
    admin('/return-reasons').catch(() => ({ data: [] })),
    admin('/refunds?order=-createdAt&limit=50').catch(() => ({ data: [] })),
  ]);
  const orders = await Promise.all([...new Set(list.data.map(row => row.orderId))].slice(0, 60)
    .map(id => admin(`/orders/${id}`).then(order => [id, order]).catch(() => [id, null])));
  const byOrder = new Map(orders);
  const reasonName = id => (reasons.data || []).find(row => row.id === id)?.label || '';
  return {
    title: 'Devoluciones',
    html: `<div class="stack">${list.data.map(record => {
      const order = byOrder.get(record.orderId);
      const lines = (record.items || []).map(item => {
        const line = (order?.items || []).find(entry => entry.id === item.lineItemId);
        return `${item.quantity} × ${esc(line?.title || item.lineItemId)}${item.reasonId ? ` · ${esc(reasonName(item.reasonId))}` : ''}`;
      });
      return `<div class="card stack">
        <div class="split"><strong>${esc(order?.code || record.orderId)}</strong>${statusBadge(record.status, { requested: 'Solicitada', approved: 'Aprobada', rejected: 'Rechazada', received: 'Recibida', closed: 'Cerrada' }[record.status])}</div>
        <div class="small">${lines.join(' · ')}</div>
        <div class="small muted">Solicitada ${dateTime(record.createdAt)}${record.note ? ` · ${esc(record.note)}` : ''}${record.refundAmount ? ` · Reembolso calculado: ${money(record.refundAmount, order?.currencyCode)}` : ''}</div>
        <div class="btn-row">
          ${record.status === 'requested' ? `<button class="btn small" data-approve="${esc(record.id)}">Aprobar</button><button class="btn ghost small" data-reject="${esc(record.id)}">Rechazar</button>` : ''}
          ${record.status === 'approved' ? `<button class="btn small" data-receive="${esc(record.id)}">Registrar recepción</button>` : ''}
          ${record.refundId ? '<span class="badge info">Reembolso generado</span>' : ''}
        </div></div>`;
    }).join('') || empty('No hay devoluciones.')}</div>
      <h2 style="margin-top:18px">Reembolsos</h2>
      ${table(['Fecha', 'Pedido', 'Importe', 'Motivo', 'Estado', ''], refunds.data.map(refund => `<tr><td>${date(refund.createdAt)}</td><td>${esc(byOrder.get(refund.orderId)?.code || refund.orderId)}</td><td>${money(refund.amount, refund.currencyCode)}</td><td>${esc(refund.reason)}</td><td>${statusBadge(refund.status)}</td>
        <td>${refund.status === 'pending' ? `<button class="btn small" data-complete-refund="${esc(refund.id)}">Marcar pagado</button>` : ''}</td></tr>`))}
      <p class="small muted">El dinero se devuelve por el mismo medio de pago desde <a href="/admin/pedidos">Pedidos</a>; acá se registra el cierre.</p>`,
    mount(root) {
      $('[data-approve]', root).forEach(button => button.addEventListener('click', act(data => admin(`/returns/${data.approve}/approve`, { method: 'POST', body: {} }))));
      $('[data-reject]', root).forEach(button => button.addEventListener('click', act(async data => {
        const reason = prompt('Motivo del rechazo (se envía al comprador):');
        if (!reason) throw new Error('Indica un motivo.');
        await admin(`/returns/${data.reject}/reject`, { method: 'POST', body: { reason } });
      })));
      $('[data-receive]', root).forEach(button => button.addEventListener('click', act(async data => {
        const record = list.data.find(row => row.id === data.receive);
        const items = (record.items || []).map(item => ({ lineItemId: item.lineItemId, receivedQuantity: item.quantity, condition: 'new', restock: true }));
        await admin(`/returns/${data.receive}/receive`, { method: 'POST', body: { items, refund: true } });
      })));
      $('[data-complete-refund]', root).forEach(button => button.addEventListener('click', act(data => admin(`/refunds/${data.completeRefund}/complete`, { method: 'POST', body: {} }))));
    },
  };
}
/** Afinado del buscador: sinónimos vigentes y lo que la gente busca sin encontrar. */
async function searchTuning() {
  const data = await admin('/marketplace/search-tuning');
  return {
    title: 'Búsqueda',
    html: `<p class="small muted">El buscador ya tolera plurales y errores de tipeo. Los sinónimos sirven para palabras distintas que significan lo mismo (por ejemplo «remera» y «camiseta»), y se editan acá sin tocar código.</p>
      <div class="kpis">${kpi('Productos indexados', data.index.documents)}${kpi('Términos', data.index.terms)}${kpi('Sinónimos', data.index.synonyms)}${kpi('Búsquedas sin resultado', data.emptySearches.length)}</div>
      <h2 style="margin-top:16px">Búsquedas sin resultado</h2>
      <p class="small muted">Cada una es una oportunidad: o falta ese producto en el catálogo, o hace falta un sinónimo.</p>
      ${data.emptySearches.length ? `<div class="chips" style="flex-wrap:wrap">${data.emptySearches.map(row => `<button class="chip" data-term="${esc(row.term)}">${esc(row.term)} <span class="muted">${row.count}</span></button>`).join('')}</div>` : '<p class="muted small">Ninguna por ahora.</p>'}
      <h2 style="margin-top:18px">Sinónimos</h2>
      ${table(['Término', 'Equivale a', 'Estado', ''], data.synonyms.map(row => `<tr><td><strong>${esc(row.term)}</strong>${row.notes ? `<div class="small muted">${esc(row.notes)}</div>` : ''}</td><td>${esc((row.equivalents || []).join(', '))}</td><td>${statusBadge(row.active ? 'active' : 'cancelled', row.active ? 'Activo' : 'Inactivo')}</td>
        <td class="nowrap"><button class="btn ghost small" data-toggle-syn="${esc(row.id)}" data-active="${!row.active}">${row.active ? 'Desactivar' : 'Activar'}</button> <button class="btn ghost small" data-edit-syn="${esc(row.id)}" data-values="${esc((row.equivalents || []).join(', '))}">Editar</button></td></tr>`))}
      <form data-synonym class="card stack" style="margin-top:12px">${formError()}<strong>Nuevo sinónimo</strong>
        <div class="grid-2"><label>Término que busca la gente<input type="text" name="term" required maxlength="60" placeholder="camiseta"></label>
        <label>Palabras equivalentes (coma)<input type="text" name="equivalents" required placeholder="remera, polera"></label></div>
        <label>Nota (opcional)<input type="text" name="notes" maxlength="200"></label>
        <button class="btn" type="submit">Crear</button></form>`,
    mount(root) {
      $('[data-term]', root).forEach(button => button.addEventListener('click', () => {
        $('[data-synonym] [name=term]', root).value = button.dataset.term;
        $('[data-synonym] [name=equivalents]', root).focus();
      }));
      $('[data-toggle-syn]', root).forEach(button => button.addEventListener('click', act(data => admin(`/search-synonyms/${data.toggleSyn}`, { method: 'PATCH', body: { active: data.active === 'true' } }))));
      $('[data-edit-syn]', root).forEach(button => button.addEventListener('click', act(async data => {
        const value = prompt('Palabras equivalentes separadas por coma:', data.values);
        if (value === null) return;
        await admin(`/search-synonyms/${data.editSyn}`, { method: 'PATCH', body: { equivalents: value.split(',').map(word => word.trim()).filter(Boolean) } });
      })));
      bindForm($('[data-synonym]', root), async values => {
        await admin('/search-synonyms', { method: 'POST', body: { term: values.term, equivalents: values.equivalents.split(',').map(word => word.trim()).filter(Boolean), notes: values.notes || undefined } });
        toast('Sinónimo activo: la búsqueda ya lo usa.');
        refresh();
      });
    },
  };
}
// --- Liquidaciones y suscripciones -----------------------------------------------------------------

async function payouts() {
  const [payables, list, plans, sellersList] = await Promise.all([admin('/marketplace/payables'), admin('/seller-payouts?order=-createdAt'), admin('/seller-plans'), admin('/marketplace/sellers?status=active')]);
  return {
    title: 'Liquidaciones',
    html: `<div class="split"><h2 style="margin:0">Por liquidar</h2><a class="btn ghost small" href="/api/v1/admin/marketplace/exports/liquidaciones">Exportar CSV</a></div><p class="small muted">Solo es liquidable lo entregado y confirmado, después del plazo de espera configurado.</p>
      ${table(['Tienda', 'Disponible', 'En espera', ''], payables.data.map(row => `<tr><td>${esc(row.sellerName)}</td><td>${money(row.eligible, row.currencyCode)}</td><td>${money(row.waiting, row.currencyCode)}</td><td>${row.eligible > 0 ? `<button class="btn small" data-payout="${esc(row.sellerId)}">Crear liquidación</button>` : ''}</td></tr>`))}
      <h2 style="margin-top:18px">Liquidaciones</h2>
      ${table(['Fecha', 'Tienda', 'Importe', 'Estado', ''], list.data.map(row => `<tr><td>${date(row.createdAt)}</td><td>${esc(sellersList.data.find(seller => seller.id === row.sellerId)?.name || row.sellerId)}</td><td>${money(row.amount, row.currencyCode)}</td><td>${statusBadge(row.status)}${row.reference ? ` <span class="small muted">${esc(row.reference)}</span>` : ''}</td><td>${row.status === 'pending' ? `<button class="btn small" data-paid="${esc(row.id)}">Marcar pagada</button>` : ''}</td></tr>`))}
      <h2 style="margin-top:18px">Suscripciones de tiendas</h2>
      <p class="small muted">Planes: ${plans.data.map(plan => `${esc(plan.name)} (${money(plan.monthlyFee, plan.currencyCode)}/mes)`).join(' · ') || 'ninguno'}</p>
      <form data-plan class="card stack">${formError()}<strong>Nuevo plan</strong><div class="grid-2"><label>Código<input type="text" name="code" required pattern="[a-z0-9-]+"></label><label>Nombre<input type="text" name="name" required></label></div>
        <div class="grid-2"><label>Cuota mensual (Gs.)<input type="text" name="monthlyFee" inputmode="numeric" required></label><label>Comisión del plan % (opcional)<input type="number" name="commissionPercent" min="0" max="100" step="0.1"></label></div><button class="btn ghost" type="submit">Crear plan</button></form>
      <form data-subscription class="card stack" style="margin-top:12px">${formError()}<strong>Registrar cobro de suscripción</strong>
        <div class="grid-2"><label>Tienda<select name="sellerId" required>${sellersList.data.map(seller => `<option value="${esc(seller.id)}">${esc(seller.name)}</option>`).join('')}</select></label><label>Período<input type="text" name="period" required placeholder="2026-09"></label></div>
        <div class="grid-2"><label>Importe (Gs.)<input type="text" name="amount" inputmode="numeric" required></label><label>Referencia<input type="text" name="reference"></label></div><button class="btn" type="submit">Registrar</button></form>`,
    mount(root) {
      $$('[data-payout]', root).forEach(button => button.addEventListener('click', act(data => admin(`/marketplace/sellers/${data.payout}/payouts`, { method: 'POST', body: {} }))));
      $$('[data-paid]', root).forEach(button => button.addEventListener('click', act(async data => {
        const reference = prompt('Referencia de la transferencia:') || undefined;
        await admin(`/seller-payouts/${data.paid}/paid`, { method: 'POST', body: compact({ reference }) });
      })));
      bindForm($('[data-plan]', root), async values => {
        await admin('/seller-plans', { method: 'POST', body: compact({ code: values.code, name: values.name, monthlyFee: parseMoney(values.monthlyFee), commissionPercent: values.commissionPercent === '' ? undefined : Number(values.commissionPercent) }) });
        refresh();
      });
      bindForm($('[data-subscription]', root), async values => {
        await admin(`/marketplace/sellers/${values.sellerId}/subscription-payments`, { method: 'POST', body: compact({ amount: parseMoney(values.amount), period: values.period, reference: values.reference }) });
        toast('Cobro registrado como ingreso por suscripción');
        refresh();
      });
    },
  };
}

// --- Comisiones -------------------------------------------------------------------------------

async function commissions() {
  const [rules, tree, sellersList] = await Promise.all([admin('/commission-rules?limit=200'), api('/marketplace/categories'), admin('/marketplace/sellers?status=active')]);
  const cats = flattenCategories(tree.tree);
  const describe = rule => {
    if (rule.scope === 'category') return cats.find(cat => cat.id === rule.scopeValue)?.name || rule.scopeValue;
    if (rule.scope === 'seller') return sellersList.data.find(seller => seller.id === rule.scopeValue)?.name || rule.scopeValue;
    return rule.scopeValue || 'Todas las ventas';
  };
  return {
    title: 'Comisiones',
    html: `<p class="small muted">Gana la regla más específica: producto › tienda › campaña › categoría › modelo comercial › global. Los importes quedan congelados en cada subpedido.</p>
      ${table(['Regla', 'Alcance', 'Aplica a', '%', 'Fijo', 'Estado', ''], rules.data.map(rule => `<tr><td>${esc(rule.name)}</td><td>${esc(rule.scope)}</td><td>${esc(describe(rule))}</td><td>${rule.percent}</td><td>${money(rule.flat, rule.currencyCode)}</td><td>${statusBadge(rule.active ? 'active' : 'cancelled', rule.active ? 'Activa' : 'Inactiva')}</td><td><button class="btn ghost small" data-toggle-rule="${esc(rule.id)}" data-active="${!rule.active}">${rule.active ? 'Desactivar' : 'Activar'}</button></td></tr>`))}
      <form data-rule class="card stack" style="margin-top:12px">${formError()}<strong>Nueva regla</strong>
        <div class="grid-2"><label>Nombre<input type="text" name="name" required></label><label>Alcance<select name="scope" data-scope><option value="global">Global</option><option value="commercialModel">Modelo comercial</option><option value="category">Categoría</option><option value="seller">Tienda</option><option value="product">Producto (id)</option><option value="campaign">Campaña (id)</option></select></label></div>
        <label>Aplica a
          <select name="scopeCategory" data-scope-field="category" hidden>${cats.map(cat => `<option value="${esc(cat.id)}">${esc(cat.name)}</option>`).join('')}</select>
          <select name="scopeSeller" data-scope-field="seller" hidden>${sellersList.data.map(seller => `<option value="${esc(seller.id)}">${esc(seller.name)}</option>`).join('')}</select>
          <select name="scopeModel" data-scope-field="commercialModel" hidden>${['LOCAL', 'PROPIO', 'DROPSHIPPING'].map(model => `<option>${model}</option>`).join('')}</select>
          <input type="text" name="scopeId" data-scope-field="product campaign" hidden placeholder="Identificador">
        </label>
        <div class="grid-2"><label>Porcentaje<input type="number" name="percent" min="0" max="100" step="0.1" value="10"></label><label>Fijo por línea (Gs.)<input type="text" name="flat" inputmode="numeric" value="0"></label></div>
        <div class="grid-2"><label>Desde<input type="date" name="startsAt"></label><label>Hasta<input type="date" name="endsAt"></label></div>
        <button class="btn" type="submit">Crear regla</button></form>
      <form data-preview class="card btn-row" style="margin-top:12px">${formError()}<input type="text" name="productId" placeholder="Id de producto para simular" style="flex:1" required><button class="btn ghost" type="submit">Simular comisión</button><div data-preview-result class="small" style="width:100%"></div></form>`,
    mount(root) {
      const sync = () => {
        const scope = $('[data-scope]', root).value;
        $$('[data-scope-field]', root).forEach(element => { element.hidden = !element.dataset.scopeField.split(' ').includes(scope); });
      };
      $('[data-scope]', root).addEventListener('change', sync);
      sync();
      $$('[data-toggle-rule]', root).forEach(button => button.addEventListener('click', act(data => admin(`/commission-rules/${data.toggleRule}`, { method: 'PATCH', body: { active: data.active === 'true' } }))));
      bindForm($('[data-rule]', root), async values => {
        const scopeValue = { category: values.scopeCategory, seller: values.scopeSeller, commercialModel: values.scopeModel, product: values.scopeId, campaign: values.scopeId }[values.scope];
        await admin('/commission-rules', { method: 'POST', body: compact({ name: values.name, scope: values.scope, scopeValue, percent: Number(values.percent || 0), flat: parseMoney(values.flat) || 0, startsAt: values.startsAt ? new Date(values.startsAt).toISOString() : undefined, endsAt: values.endsAt ? new Date(`${values.endsAt}T23:59:59`).toISOString() : undefined }) });
        refresh();
      });
      bindForm($('[data-preview]', root), async values => {
        const result = await admin(`/marketplace/commission-preview?productId=${encodeURIComponent(values.productId)}`);
        $('[data-preview-result]', root).textContent = `Base ${money(result.base)} → comisión ${money(result.amount)} por la regla «${result.rule.name}» (${result.rule.scope}, ${result.rule.percent}%).`;
      });
    },
  };
}

// --- Categorías y localidades ----------------------------------------------------------------------

async function categoriesView() {
  const result = await admin('/categories?limit=200&order=path');
  const cats = result.data;
  return {
    title: 'Categorías',
    html: `<p class="small muted">El árbol se edita sin tocar código. Una categoría con subcategorías no se puede borrar.</p>
      ${table(['Categoría', 'Ruta', 'Orden', 'Visible', ''], cats.map(cat => `<tr><td style="padding-left:${10 + (cat.depth || 0) * 18}px">${esc(cat.name)}</td><td class="small muted">${esc(cat.path)}</td><td>${cat.rank}</td><td>${cat.visible ? 'Sí' : 'No'}</td><td class="nowrap"><button class="btn ghost small" data-rename="${esc(cat.id)}" data-name="${esc(cat.name)}">Renombrar</button> <button class="btn ghost small" data-visible="${esc(cat.id)}" data-value="${!cat.visible}">${cat.visible ? 'Ocultar' : 'Mostrar'}</button></td></tr>`))}
      <form data-category class="card stack" style="margin-top:12px">${formError()}<strong>Nueva categoría</strong><div class="grid-2"><label>Nombre<input type="text" name="name" required></label><label>Dentro de<select name="parentId"><option value="">(principal)</option>${cats.map(cat => `<option value="${esc(cat.id)}">${esc(cat.path)}</option>`).join('')}</select></label></div><label>Descripción<input type="text" name="description"></label><button class="btn" type="submit">Crear</button></form>`,
    mount(root) {
      $$('[data-rename]', root).forEach(button => button.addEventListener('click', act(async data => {
        const name = prompt('Nuevo nombre:', data.name);
        if (name) await admin(`/categories/${data.rename}`, { method: 'PATCH', body: { name } });
      })));
      $$('[data-visible]', root).forEach(button => button.addEventListener('click', act(data => admin(`/categories/${data.visible}`, { method: 'PATCH', body: { visible: data.value === 'true' } }))));
      bindForm($('[data-category]', root), async values => {
        await admin('/categories', { method: 'POST', body: compact(values) });
        refresh();
      });
    },
  };
}

async function localities() {
  const result = await admin('/localities?limit=200');
  const parents = result.data.filter(row => row.type !== 'city');
  return {
    title: 'Localidades',
    html: `<p class="small muted">Para abrir el marketplace en otra ciudad, pasá su estado a «activa». No hace falta cambiar código.</p>
      ${table(['Localidad', 'Tipo', 'Zonas', 'Estado', ''], result.data.map(row => `<tr><td>${esc(row.name)}</td><td>${esc(row.type)}</td><td class="small">${esc((row.areas || []).join(', '))}</td><td>${statusBadge(row.launchStatus === 'active' ? 'active' : 'pending', { active: 'Activa', coming_soon: 'Próximamente', hidden: 'Oculta' }[row.launchStatus])}</td>
        <td class="nowrap"><select data-launch="${esc(row.id)}" style="width:auto;min-height:36px">${['active', 'coming_soon', 'hidden'].map(value => `<option value="${value}" ${row.launchStatus === value ? 'selected' : ''}>${{ active: 'Activa', coming_soon: 'Próximamente', hidden: 'Oculta' }[value]}</option>`).join('')}</select> ${row.type === 'city' ? `<button class="btn ghost small" data-areas="${esc(row.id)}" data-value="${esc((row.areas || []).join(', '))}">Zonas</button>` : ''}</td></tr>`))}
      <form data-locality class="card stack" style="margin-top:12px">${formError()}<strong>Nueva ciudad</strong>
        <div class="grid-2"><label>Nombre<input type="text" name="name" required></label><label>Código<input type="text" name="code" required pattern="[a-z0-9-]+"></label></div>
        <div class="grid-2"><label>Departamento<select name="parentId">${parents.map(row => `<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('')}</select></label><label>Zonas (coma)<input type="text" name="areas" placeholder="Centro, Barrio…"></label></div>
        <div class="grid-2"><label>Latitud centro<input type="text" name="lat"></label><label>Longitud centro<input type="text" name="lng"></label></div>
        <button class="btn" type="submit">Crear</button></form>`,
    mount(root) {
      $$('[data-launch]', root).forEach(select => select.addEventListener('change', async () => {
        try { await admin(`/localities/${select.dataset.launch}`, { method: 'PATCH', body: { launchStatus: select.value } }); toast('Localidad actualizada'); } catch (error) { toast(error.message); }
      }));
      $$('[data-areas]', root).forEach(button => button.addEventListener('click', act(async data => {
        const value = prompt('Zonas generales separadas por coma:', data.value);
        if (value !== null) await admin(`/localities/${data.areas}`, { method: 'PATCH', body: { areas: value.split(',').map(area => area.trim()).filter(Boolean) } });
      })));
      bindForm($('[data-locality]', root), async values => {
        const lat = Number(values.lat); const lng = Number(values.lng);
        await admin('/localities', { method: 'POST', body: compact({ name: values.name, code: values.code, type: 'city', parentId: values.parentId, countryCode: 'py', launchStatus: 'coming_soon', areas: values.areas ? values.areas.split(',').map(area => area.trim()).filter(Boolean) : undefined, center: values.lat && values.lng ? { lat, lng } : undefined, bounds: values.lat && values.lng ? { north: lat + 0.06, south: lat - 0.06, east: lng + 0.08, west: lng - 0.08 } : undefined }) });
        refresh();
      });
    },
  };
}

// --- Dropshipping --------------------------------------------------------------------------------------

async function suppliers() {
  const [list, summary, orders] = await Promise.all([admin('/suppliers?limit=200'), admin('/dropshipping/summary'), admin('/supplier-orders?order=-createdAt&limit=50')]);
  const names = new Map(list.data.map(row => [row.id, row.name]));
  return {
    title: 'Dropshipping',
    html: `${table(['Proveedor', 'Integración', 'Estado', 'Productos', 'Ventas', 'Costo', 'Margen', ''], summary.data.map(row => `<tr><td>${esc(row.name)}</td><td>${esc(row.integrationType)}</td><td>${statusBadge(row.status)}</td><td>${row.products}</td><td>${money(row.sales)}</td><td>${money(row.cost)}</td><td>${money(row.margin)}${row.marginPercent !== null ? ` (${row.marginPercent}%)` : ''}</td>
        <td class="nowrap">${row.status !== 'active' ? `<button class="btn small" data-supplier-status="${esc(row.supplierId)}" data-value="active">Activar</button>` : `<button class="btn ghost small" data-supplier-status="${esc(row.supplierId)}" data-value="suspended">Suspender</button>`} <button class="btn ghost small" data-import="${esc(row.supplierId)}">Importar CSV</button></td></tr>`))}
      <h2 style="margin-top:18px">Pedidos a proveedores</h2>
      ${table(['Pedido', 'Proveedor', 'Costo', 'Estado', 'Seguimiento', ''], orders.data.map(order => `<tr><td>${esc(order.code)}<div class="small muted">${ago(order.createdAt)}</div></td><td>${esc(names.get(order.supplierId) || '')}</td><td>${money(order.costTotal, order.currencyCode)}</td><td>${statusBadge(order.status)}</td><td class="small">${esc(order.tracking?.trackingNumber || '—')}</td>
        <td class="nowrap">${order.status === 'pending' ? `<button class="btn small" data-send="${esc(order.id)}">Enviar al proveedor</button>` : ''}${['sent', 'accepted'].includes(order.status) ? `<button class="btn ghost small" data-ship="${esc(order.id)}">Registrar despacho</button>` : ''}${order.status === 'shipped' ? `<button class="btn ghost small" data-deliver="${esc(order.id)}">Entregado</button>` : ''}</td></tr>`))}
      <form data-supplier class="card stack" style="margin-top:12px">${formError()}<strong>Nuevo proveedor</strong>
        <div class="grid-2"><label>Nombre<input type="text" name="name" required></label><label>Código<input type="text" name="code" required pattern="[a-z0-9-]+"></label></div>
        <div class="grid-2"><label>Integración<select name="integrationType"><option value="manual">Manual</option><option value="csv">CSV</option><option value="api">API (requiere adaptador)</option></select></label><label>Correo<input type="email" name="contactEmail"></label></div>
        <label>Plazo de entrega (días)<input type="number" name="defaultLeadTimeDays" min="0" value="5"></label>
        <button class="btn" type="submit">Crear</button></form>
      <p class="small muted">Los productos de dropshipping se cargan desde <a href="/admin/productos">Productos</a> eligiendo el proveedor; el precio debe superar el costo.</p>`,
    mount(root) {
      $$('[data-supplier-status]', root).forEach(button => button.addEventListener('click', act(data => admin(`/dropshipping/suppliers/${data.supplierStatus}/status`, { method: 'POST', body: { status: data.value } }))));
      $$('[data-send]', root).forEach(button => button.addEventListener('click', act(async data => {
        const externalReference = prompt('Referencia del pedido en el proveedor (opcional):') || undefined;
        await admin(`/dropshipping/supplier-orders/${data.send}/send`, { method: 'POST', body: compact({ externalReference }) });
      })));
      $$('[data-ship]', root).forEach(button => button.addEventListener('click', act(async data => {
        const trackingNumber = prompt('Número de seguimiento:');
        const carrier = prompt('Transportista:') || undefined;
        await admin(`/dropshipping/supplier-orders/${data.ship}/status`, { method: 'POST', body: { status: 'shipped', tracking: compact({ trackingNumber, carrier }) } });
      })));
      $$('[data-deliver]', root).forEach(button => button.addEventListener('click', act(data => admin(`/dropshipping/supplier-orders/${data.deliver}/status`, { method: 'POST', body: { status: 'delivered' } }))));
      $$('[data-import]', root).forEach(button => button.addEventListener('click', act(async data => {
        const csv = prompt('Pegá el CSV (supplier_sku,name,cost,stock,lead_time_days):');
        if (!csv) return;
        const report = await admin(`/dropshipping/suppliers/${data.import}/catalog-import`, { method: 'POST', body: { csv: csv.replace(/\\n/g, '\n'), dryRun: false } });
        toast(`Actualizados ${report.updated}, desconocidos ${report.unknown}, con error ${report.invalid}.`);
      })));
      bindForm($('[data-supplier]', root), async values => {
        await admin('/suppliers', { method: 'POST', body: compact({ ...values, defaultLeadTimeDays: Number(values.defaultLeadTimeDays || 0) }) });
        refresh();
      });
    },
  };
}

// --- Afiliados, publicidad, moderación, analítica, avisos, configuración -----------------------------------

async function affiliates() {
  const [totals, dashboard, affiliateProducts] = await Promise.all([
    admin('/commissions/totals').catch(() => null),
    admin('/marketplace/dashboard'),
    api('/marketplace/search?model=AFILIADO&limit=48'),
  ]);
  return {
    title: 'Afiliados',
    html: `<div class="notice small">Una comisión pendiente no es ingreso: solo lo es cuando el programa la paga. Las conversiones entran por importación CSV o por postback firmado (<code>POST /api/v1/store/affiliate/postbacks/:networkId</code>).</div>
      ${affiliateKpis(dashboard.affiliateRevenue)}
      ${totals ? `<pre class="card small" style="overflow:auto">${esc(JSON.stringify(totals, null, 2))}</pre>` : ''}
      <h2 style="margin-top:14px">Productos afiliados en el catálogo (${affiliateProducts.count})</h2>
      ${table(['Producto', 'Comercio', 'Precio'], affiliateProducts.data.map(item => `<tr><td><a href="/producto/${esc(item.handle)}">${esc(item.name)}</a></td><td>${esc(item.merchantName || '')}</td><td>${money(item.price.amount, item.price.currency)}</td></tr>`))}
      <p style="margin-top:12px"><a class="btn ghost" href="/panel.html">Abrir el panel de afiliación (programas, enlaces, clics, conversiones y pagos)</a></p>`,
  };
}

async function ads() {
  const result = await admin('/advertising/report');
  return {
    title: 'Publicidad',
    html: `<p class="small muted">Un anuncio se sirve solo si está aprobado, cobrado (o eximido) y dentro de sus fechas. Siempre sale etiquetado como «Patrocinado» y fuera del ranking orgánico.</p>
      ${table(['Anuncio', 'Tipo', 'Fechas', 'Tarifa', 'Estado', 'Pago', 'Rendimiento', ''], result.data.map(ad => `<tr><td>${esc(ad.title)}</td><td class="small">${esc(ad.type)} · ${esc(ad.placement)}</td><td class="small">${date(ad.startsAt)}–${date(ad.endsAt)}</td><td>${money(ad.rate, ad.currencyCode)} ${esc(ad.pricingModel)}</td><td>${statusBadge(ad.status)}${ad.live ? ' <span class="badge ok">En línea</span>' : ''}</td><td>${statusBadge(ad.paymentStatus)}</td><td class="small">${ad.impressions} imp · ${ad.clicks} clics · CTR ${ad.ctr ?? '—'}</td>
        <td class="nowrap">${ad.status === 'pending_review' ? `<button class="btn small" data-review="${esc(ad.id)}" data-decision="approve">Aprobar</button> <button class="btn ghost small" data-review="${esc(ad.id)}" data-decision="reject">Rechazar</button>` : ''}${ad.status === 'approved' && ad.paymentStatus === 'unpaid' ? `<button class="btn small" data-pay="${esc(ad.id)}" data-amount="${ad.rate}">Registrar cobro</button>` : ''}</td></tr>`))}`,
    mount(root) {
      $$('[data-review]', root).forEach(button => button.addEventListener('click', act(async data => {
        const note = prompt('Nota para la tienda (opcional):') || undefined;
        await admin(`/ad-campaigns/${data.review}/review`, { method: 'POST', body: compact({ decision: data.decision, note }) });
      })));
      $$('[data-pay]', root).forEach(button => button.addEventListener('click', act(async data => {
        const amount = parseMoney(prompt('Importe cobrado (Gs.):', data.amount));
        if (!amount) return;
        await admin(`/ad-campaigns/${data.pay}/payment`, { method: 'POST', body: { amount } });
      })));
    },
  };
}

async function moderation() {
  const data = await admin('/community/moderation');
  const actionsFor = type => ({ product: ['unpublished'], seller: ['suspended'], review: ['hidden'], post: ['hidden'], question: ['hidden'], message: ['hidden'], user: ['blocked'] }[type] || []);
  return {
    title: 'Moderación',
    html: `<div class="kpis">${kpi('Reportes abiertos', data.counts.reports)}${kpi('Reseñas pendientes', data.counts.pendingReviews)}${kpi('Mensajes retenidos', data.counts.flaggedMessages)}</div>
      <h2 style="margin-top:14px">Reportes</h2>
      <div class="stack">${data.reports.map(report => `<div class="card stack"><div class="split"><strong>${esc(report.targetType)} · ${esc(report.reason)}</strong>${statusBadge(report.status)}</div>
        <p class="small" style="margin:0">«${esc(report.preview || '(sin vista previa)')}»</p>${report.details ? `<p class="small muted" style="margin:0">${esc(report.details)}</p>` : ''}<span class="small muted">${ago(report.createdAt)}</span>
        <div class="btn-row">${actionsFor(report.targetType).map(action => `<button class="btn small" data-resolve="${esc(report.id)}" data-action-type="${action}">${{ unpublished: 'Retirar producto', suspended: 'Suspender tienda', hidden: 'Ocultar', blocked: 'Bloquear usuario' }[action]}</button>`).join('')}
          <button class="btn ghost small" data-resolve="${esc(report.id)}" data-action-type="warned">Advertir</button><button class="btn ghost small" data-dismiss="${esc(report.id)}">Descartar</button></div></div>`).join('') || empty('Sin reportes abiertos.', { emoji: '✅' })}</div>
      <h2 style="margin-top:14px">Reseñas pendientes</h2>${data.pendingReviews.map(review => `<div class="card split"><span>${review.rating}★ ${esc(review.comment || '')} <span class="small muted">— ${esc(review.author)}</span></span><span class="btn-row"><button class="btn small" data-review-status="${esc(review.id)}" data-value="published">Publicar</button><button class="btn ghost small" data-review-status="${esc(review.id)}" data-value="rejected">Rechazar</button></span></div>`).join('') || '<p class="muted">Ninguna.</p>'}
      <h2 style="margin-top:14px">Mensajes retenidos</h2>${data.flaggedMessages.map(message => `<div class="card split"><span class="small">${esc(message.body)} <span class="muted">(${esc(message.flags.join(', '))})</span></span><span class="btn-row"><button class="btn small" data-message="${esc(message.id)}" data-value="sent">Entregar</button><button class="btn ghost small" data-message="${esc(message.id)}" data-value="hidden">Ocultar</button></span></div>`).join('') || '<p class="muted">Ninguno.</p>'}`,
    mount(root) {
      $$('[data-resolve]', root).forEach(button => button.addEventListener('click', act(async data => {
        const resolution = prompt('Resolución (queda en el registro):') || undefined;
        await admin(`/community/reports/${data.resolve}/resolve`, { method: 'POST', body: compact({ status: 'resolved', action: data.actionType, resolution }) });
      })));
      $$('[data-dismiss]', root).forEach(button => button.addEventListener('click', act(data => admin(`/community/reports/${data.dismiss}/resolve`, { method: 'POST', body: { status: 'dismissed', action: 'none' } }))));
      $$('[data-review-status]', root).forEach(button => button.addEventListener('click', act(data => admin(`/community/reviews/${data.reviewStatus}/moderate`, { method: 'POST', body: { status: data.value } }))));
      $$('[data-message]', root).forEach(button => button.addEventListener('click', act(data => admin(`/community/messages/${data.message}/moderate`, { method: 'POST', body: { status: data.value } }))));
    },
  };
}

async function analytics() {
  const data = await admin('/marketplace/analytics?days=30');
  const list = (rows, render) => (rows.length ? `<ol class="small" style="padding-left:18px;margin:0">${rows.map(row => `<li>${render(row)}</li>`).join('')}</ol>` : '<p class="muted small">Sin datos.</p>');
  return {
    title: 'Analítica',
    html: `<p class="small muted">${esc(data.note)} Últimos ${data.range.days} días.</p>
      <div class="kpis">${kpi('Vistas de producto', data.funnel.productViews)}${kpi('Búsquedas', data.funnel.searches)}${kpi('Clics afiliados', data.funnel.affiliateClicks)}${kpi('Favoritos', data.funnel.favorites)}${kpi('Carritos con productos', data.funnel.cartsWithItems)}${kpi('Compras', data.funnel.purchases)}${kpi('Conversión vista→compra', data.funnel.conversionRate === null ? '—' : `${data.funnel.conversionRate}%`)}${kpi('Conversión carrito→compra', data.funnel.cartConversionRate === null ? '—' : `${data.funnel.cartConversionRate}%`)}</div>
      <div class="grid-2" style="margin-top:14px">
        <div class="card"><h3>Más vendidos</h3>${list(data.bestSellers, row => `${esc(row.name)} — ${row.units} u`)}</div>
        <div class="card"><h3>Más vistos</h3>${list(data.popularProducts, row => `${esc(row.name)} — ${row.views}`)}</div>
        <div class="card"><h3>Tiendas con más ventas</h3>${list(data.popularSellers, row => `${esc(row.name)} — ${money(row.sales)}`)}</div>
        <div class="card"><h3>Categorías más vendidas</h3>${list(data.popularCategories, row => `${esc(row.name)} — ${row.units} u`)}</div>
        <div class="card"><h3>Búsquedas frecuentes</h3>${list(data.topSearches, row => `${esc(row.term)} (${row.total})`)}</div>
        <div class="card"><h3>Búsquedas sin resultado</h3>${list(data.emptySearches, row => `${esc(row.term)} (${row.count})`)}<p class="small muted">Oportunidades de catálogo o sinónimos.</p></div>
      </div>`,
  };
}

async function inbox() {
  const data = await admin('/marketplace/inbox');
  if (data.unread) admin('/marketplace/inbox/read', { method: 'POST', body: {} }).catch(() => {});
  return {
    title: 'Avisos',
    html: `<div class="card">${data.data.map(item => `<div class="list-row"><div><strong>${item.readAt ? '' : '● '}${esc(item.title)}</strong>${item.body ? `<div class="small muted">${esc(item.body)}</div>` : ''}<div class="small muted">${ago(item.createdAt)}</div></div>${item.link ? `<a class="btn ghost small" href="${esc(item.link)}">Abrir</a>` : ''}</div>`).join('') || '<p class="muted">Sin avisos.</p>'}</div>`,
  };
}

async function settingsView() {
  const [settings, integrations] = await Promise.all([admin('/settings'), admin('/marketplace/integrations')]);
  const mp = settings.marketplace || {};
  return {
    title: 'Configuración',
    html: `<form data-settings class="card stack">${formError()}
        <h2>Marketplace</h2>
        <div class="grid-2"><label>Nombre<input type="text" name="name" value="${esc(mp.name || '')}"></label><label>Modo de comercio<select name="commerceMode">${['AFFILIATE', 'HYBRID', 'DIRECT'].map(mode => `<option ${settings.commerceMode === mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></label></div>
        <label>Lema<input type="text" name="tagline" value="${esc(mp.tagline || '')}"></label>
        <label class="check"><input type="checkbox" name="sellerApprovalRequired" ${mp.sellerApprovalRequired ? 'checked' : ''}> Las tiendas nuevas requieren aprobación</label>
        <label class="check"><input type="checkbox" name="productModerationRequired" ${mp.productModerationRequired ? 'checked' : ''}> Los productos nuevos requieren moderación</label>
        <label class="check"><input type="checkbox" name="reviewsRequirePurchase" ${mp.reviewsRequirePurchase ? 'checked' : ''}> Solo se valora lo comprado y recibido</label>
        <label class="check"><input type="checkbox" name="reviewsRequireModeration" ${mp.reviewsRequireModeration ? 'checked' : ''}> Las reseñas pasan por moderación</label>
        <div class="grid-2"><label>Mensajes por minuto (antispam)<input type="number" name="messagesPerMinute" min="1" max="120" value="${mp.messagesPerMinute ?? 6}"></label><label>Días de espera antes de liquidar<input type="number" name="payoutDelayDays" min="0" max="120" value="${mp.payoutDelayDays ?? 7}"></label></div>
        <label>Versión de términos para vendedores<input type="text" name="sellerTermsVersion" value="${esc(mp.sellerTermsVersion || '')}"></label>
        <button class="btn" type="submit">Guardar</button></form>
      <section class="card" style="margin-top:12px"><h2>Integraciones</h2>${integrations.adapters.map(group => `<p class="small"><strong>${esc(group.kind)}</strong>: ${group.adapters.map(adapter => `${esc(adapter.name)} ${adapter.configured ? '✓' : '(sin configurar)'}`).join(' · ')}</p>`).join('')}
        <p class="small muted">Las pasarelas de pago, transportistas, APIs de proveedores e IA se activan registrando un adaptador con credenciales reales; no hay integraciones simuladas.</p></section>`,
    mount(root) {
      bindForm($('[data-settings]', root), async values => {
        await admin('/settings', {
          method: 'PATCH',
          body: {
            commerceMode: values.commerceMode,
            marketplace: compact({
              name: values.name, tagline: values.tagline, sellerApprovalRequired: values.sellerApprovalRequired, productModerationRequired: values.productModerationRequired,
              reviewsRequirePurchase: values.reviewsRequirePurchase, reviewsRequireModeration: values.reviewsRequireModeration,
              messagesPerMinute: Number(values.messagesPerMinute), payoutDelayDays: Number(values.payoutDelayDays), sellerTermsVersion: values.sellerTermsVersion,
            }),
          },
        });
        toast('Configuración guardada');
      });
    },
  };
}

const HANDLERS = {
  '': overview, vendedores: sellers, productos: products, pedidos: orders, devoluciones: returnsView, liquidaciones: payouts, comisiones: commissions,
  categorias: categoriesView, localidades: localities, proveedores: suppliers, afiliados: affiliates, publicidad: ads,
  moderacion: moderation, analitica: analytics, busqueda: searchTuning, avisos: inbox, configuracion: settingsView,
};
