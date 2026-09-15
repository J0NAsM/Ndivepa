# Seguridad y variables

Git y disponibilidad de herramientas son observaciones fechadas, no reglas permanentes. Respaldar datos JSON.

Los archivos .env reales se conservan fuera del contexto y deben estar ignorados por Git. Los ejemplos no prueban que una variable sea obligatoria; se mantiene NO DETERMINADO hasta revisar su validación en código.

| NOMBRE_VARIABLE | PROPÓSITO | EJEMPLO_SEGURO | REQUERIDA | FUENTES |
|---|---|---|---|---|
| ATTRIBUTION_WINDOW_DAYS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| BACKUP_KEEP | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| CDN_BASE_URL | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| COMMERCE_MODE | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| CORS_ORIGINS | Orígenes autorizados | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| CUSTOMER_SESSION_COOKIE | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| DATA_DIR | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| DEFAULT_LOCALE | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| DISCOVERY_CACHE_TTL_MS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| DISCOVERY_TIMEOUT_MS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| FEATURE_2FA | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| FEATURE_GRAPHQL | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| FEATURE_SEARCH | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| FEATURE_TREND_DISCOVERY | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| FEATURE_WEBHOOKS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| GOOGLE_TRENDS_GEO | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| HEADERS_TIMEOUT_MS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| HOST | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| INITIAL_ADMIN_EMAIL | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| INITIAL_ADMIN_PASSWORD | Configuración específica; consultar el consumidor y las fuentes indicadas | REEMPLAZAR_LOCALMENTE | NO DETERMINADO; verificar modo de ejecución | .env.example |
| JOBS_ENABLED | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| JOBS_TICK_MS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| KEEP_ALIVE_TIMEOUT_MS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| LINK_STALE_DAYS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| LOGIN_LOCK_MINUTES | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| LOGIN_MAX_ATTEMPTS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| LOW_STOCK_THRESHOLD | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| MAX_BODY_BYTES | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| MAX_JSON_DEPTH | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| MAX_QUERY_PARAMS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| MAX_UPLOAD_BYTES | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| MAX_URL_LENGTH | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| NODE_ENV | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| PASSWORD_MIN_LENGTH | Configuración específica; consultar el consumidor y las fuentes indicadas | REEMPLAZAR_LOCALMENTE | NO DETERMINADO; verificar modo de ejecución | .env.example |
| PAYMENT_API_KEY | Configuración específica; consultar el consumidor y las fuentes indicadas | REEMPLAZAR_LOCALMENTE | NO DETERMINADO; verificar modo de ejecución | .env.example |
| PAYMENT_PROVIDER | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| PAYMENT_WEBHOOK_SECRET | Configuración específica; consultar el consumidor y las fuentes indicadas | REEMPLAZAR_LOCALMENTE | NO DETERMINADO; verificar modo de ejecución | .env.example |
| PORT | Puerto de escucha | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| PRICE_STALE_DAYS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| PUBLIC_BASE_URL | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| RATE_API_MAX | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| RATE_CLICK_MAX | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| RATE_LOGIN_MAX | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| RATE_VIEW_MAX | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| RATE_WRITE_MAX | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| REQUEST_TIMEOUT_MS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| S3_ACCESS_KEY | Configuración específica; consultar el consumidor y las fuentes indicadas | REEMPLAZAR_LOCALMENTE | NO DETERMINADO; verificar modo de ejecución | .env.example |
| S3_BUCKET | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| S3_ENDPOINT | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| S3_REGION | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| S3_SECRET_KEY | Configuración específica; consultar el consumidor y las fuentes indicadas | REEMPLAZAR_LOCALMENTE | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SCRYPT_COST | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SEARCH_API_KEY | Configuración específica; consultar el consumidor y las fuentes indicadas | REEMPLAZAR_LOCALMENTE | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SEARCH_PROVIDER | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SEED_DEMO | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SEED_ENABLED | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SESSION_COOKIE | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SHUTDOWN_GRACE_MS | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SMTP_FROM | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SMTP_URL | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SNAPSHOT_DIR | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SNAPSHOT_KEEP | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| STORAGE_PRETTY | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| SUPPORTED_LOCALES | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| TRUST_PROXY | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |
| TZ_DISPLAY | Configuración específica; consultar el consumidor y las fuentes indicadas | NO DETERMINADO | NO DETERMINADO; verificar modo de ejecución | .env.example |

No ejecutar proveedores, pagos, mensajería ni migraciones reales durante una validación documental.
