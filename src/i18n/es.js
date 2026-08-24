/**
 * Mensajes de interfaz en español (M-0049, M-0100).
 * Es el idioma por defecto y el respaldo de los demás.
 */
export const SPANISH_MESSAGES = {
  'error.unauthorized': 'Inicia sesión para continuar.',
  'error.forbidden': 'No tienes permiso para esta operación.',
  'error.not_found': 'No se encontró el recurso solicitado.',
  'error.validation': 'Los datos enviados no son válidos.',
  'error.conflict': 'La operación entra en conflicto con el estado actual.',
  'error.rate_limited': 'Demasiadas solicitudes; intenta de nuevo más tarde.',
  'error.commerce_mode_disabled': 'Esta capacidad no está disponible en el modo actual.',
  'error.internal': 'Error interno del servidor.',

  'affiliate.disclosure': 'Algunos enlaces son enlaces de afiliado. Podemos recibir una comisión si realizas una compra, sin costo adicional para ti.',
  'affiliate.price_unverified': 'El precio se registró hace {days} días y no está verificado hoy.',
  'affiliate.external_purchase': 'La compra se realiza en el comercio externo, que gestiona el pago y el envío.',

  'commerce.cart_disabled': 'El carrito no está disponible: la plataforma opera en modo afiliado.',
  'commerce.out_of_stock': 'Sin stock disponible.',
  'commerce.low_stock': 'Últimas unidades.',
  'commerce.backorder': 'Disponible por encargo.',
  'commerce.price_changed': 'El precio de {title} cambió desde que lo añadiste.',

  'order.placed': 'Pedido registrado.',
  'order.confirmed': 'Pedido confirmado.',
  'order.cancelled': 'Pedido cancelado.',
  'order.shipped': 'Pedido enviado.',

  'metric.attributed_sales': 'Ventas atribuidas al comercio',
  'metric.commission_pending': 'Comisión pendiente',
  'metric.commission_approved': 'Comisión aprobada',
  'metric.commission_paid': 'Comisión pagada',
  'metric.own_income': 'Ingreso propio confirmado',
  'metric.note_not_income': 'Una comisión pendiente no es ingreso.',
};

export default SPANISH_MESSAGES;
