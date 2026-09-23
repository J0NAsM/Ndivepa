# Persistencia — Ndivepa

Node/HTML/JS; JSON local; incluye GraphQL

Git y disponibilidad de herramientas son observaciones fechadas, no reglas permanentes. Respaldar datos JSON.

## Fuentes locales

- Documento único `data/db.json` (o `DATA_DIR`), esquema versionado en [src/migrations.js](<../src/migrations.js>).
- **v4 (marketplace, 2026-09-22)**: solo añade colecciones (`localities`, `sellerMembers`, `sellerApplications`, `sellerPlans`, `commissionRules`, `vendorOrders`, `ledgerEntries`, `sellerPayouts`, `inboxNotifications`, `favorites`, `likes`, `follows`, `reviews`, `questions`, `posts`, `feedItems`, `reports`, `conversations`, `messages`, `suppliers`, `supplierMembers`, `supplierProducts`, `supplierOrders`, `adCampaigns`, `adEvents`, `searchSynonyms`, `stockAlerts`), deduce `commercialModel` de cada producto existente, agrega campos de tienda a `sellers` y completa `active: true` en filas sembradas que no lo tenían. No borra ni modifica importes. El carrito suma `recoveryRemindedAt` y `recoveredAt` (recordatorio y rescate de carritos abandonados), ambos opcionales. El `Store` guarda un snapshot antes de migrar.
- Detalle de modelos y decisiones: [Marketplace.md](Marketplace.md).


Versión efectiva de una DB remota, último backup y última restauración: NO DETERMINADO. No inferir esos datos de la versión esperada en código. No editar migraciones aplicadas ni ejecutar DDL como efecto del arranque documental.
