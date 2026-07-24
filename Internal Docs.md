# Internal Technical Documentation - Comment App

## 1. Resumen y Separación de Otros Proyectos
`Comment App` es una aplicación web independiente construida desde cero con Next.js (App Router), TypeScript y PostgreSQL en Neon. Permite crear campañas basadas en posts de X (Twitter), generar inventarios deterministas de comentarios únicos en inglés mediante la Responses API de OpenAI (GPT-5.4) y entregar atómicamente a cada visitante un único par indivisible `{post concreto de X + comentario exclusivo}`.

Esta aplicación no tiene vínculos, dependencias, importaciones ni conexiones con `genieorb_social_radar` ni con `genieorb_webapp`. Funciona con su propia base de datos, sus propias variables de entorno y su propia identidad de dominio.

## 2. Flujo Administrativo
El panel administrativo se encuentra en español:
- `/admin/login`: Acceso privado protegido por una única contraseña con hash `scrypt`.
- `/admin`: Creación y gestión de campañas.

El formulario de creación solicita exclusivamente:
1. `URLs de los posts de X` (una o varias URLs).
2. `Dirección de los comentarios (opcional)` (texto libre con instrucciones de tono o enfoque).

No existen campos para nombre, idioma, cantidad, modelo, temperatura ni estilos avanzados.

Al crear una campaña:
1. Se deduplican las URLs y se extraen los IDs de post.
2. Se recupera el contenido mediante la API oficial v2 de X.
3. Se realiza el preflight de seguridad semántico con GPT-5.4.
4. Se asigna un identificador interno correlativo (`Campaña 001`, `Campaña 002`, etc.).
5. Se genera un slug aleatorio seguro de 16 bytes.
6. Se crea una única URL pública `/comment/{slug}`.
7. Se encola automáticamente el lote inicial de 50 slots.
8. Se inicia el worker en segundo plano.
9. La campaña se mantiene desactivada por defecto.

## 3. Campañas y URL Única
Cada campaña posee exactamente un slug y una URL pública estable:
`{APP_BASE_URL}/comment/{slug}`

El slug nunca cambia tras la creación. No se utilizan códigos por canal ni sublinks.
La aplicación utiliza globalmente la cabecera `Referrer-Policy: no-referrer` para blindar la procedencia cuando los enlaces hacia X se abren desde la vista pública o administrativa. Todos los enlaces externos se abren con `rel="noopener noreferrer"`.

## 4. Importación desde X (Twitter)
- Acepta únicamente URLs con ID numérico procedentes de `x.com`, `www.x.com`, `mobile.x.com`, `twitter.com`, `www.twitter.com`, `mobile.twitter.com`.
- No realiza peticiones directas contra la URL del usuario (prevención estricta de SSRF). Se extrae el ID numérico y se consulta únicamente el endpoint oficial `api.x.com/2/tweets`.
- Usa autenticación App-Only mediante `X_BEARER_TOKEN` en servidor.
- Consulta campos oficiales (`created_at`, `text`, `author_id`, `conversation_id`, `referenced_tweets`, `lang`, `possibly_sensitive`, etc.).
- Si el post es una respuesta, recupera hasta 5 padres inmediatos como contexto.
- Si un post no existe, fue eliminado, es privado o no contiene texto suficiente, la creación falla con un error claro en español.
- **Edición y conservación histórica**:
  - Es posible añadir nuevos posts a una campaña existente y retirar posts.
  - La retirada es puramente lógica (`retired_at`). Los jobs ya creados continúan ligados a los mismos IDs inmutables de post, por lo que la tanda en ejecución se mantiene intacta.
  - Los ciclos futuros creados para la campaña usarán únicamente los posts que permanezcan vigentes (`retired_at IS NULL`).

## 5. Seguridad de Campañas y Preflight
Antes de crear el lote de slots, se evalúa el texto del post y la dirección administrativa contra la política de rechazo:
- Rechaza: amenazas, incitación a la violencia, acoso coordinado, odio contra clases protegidas, explotación sexual, doxxing, fraude, instrucciones ilegales, spam engañoso o falsas acusaciones delictivas.
- No rechaza: críticas legítimas, desacuerdo político, apoyo, admiración, sátira, preguntas o campañas comerciales.
- Ejecuta un preflight estructurado mediante GPT-5.4 (`allowed`, `category`, `reason`). El texto del post se trata como contenido no confiable.

## 6. GPT-5.4 y Responses API
- Modelo: configurable vía `OPENAI_MODEL` (por defecto `gpt-5.4`). Este valor se inyecta y persiste en todas las tablas (`generation_cycles`, `generation_jobs`, `suggestions`) para mantener un registro histórico preciso de con qué modelo se generó cada sugerencia, tal como exige el contrato.
- SDK oficial `openai`, Responses API (`responses.parse`), Structured Outputs con Zod, `store: false`.
- Cada petición genera exactamente 1 comentario estructurado en inglés.
- No se utilizan traducciones, Batch API, modelos mini/nano ni generación de imágenes.

## 7. Plan Determinista de 50 Slots
Cada ciclo de 50 comentarios sigue un plan determinista pre-calculado:
- 35 slots `ultra_short` (6 con 1 emoji, 29 sin emojis). Maximum 20 palabras, 1 sentence, 180 Unicode chars.
- 15 slots `normal` sin emojis. Maximum 45 palabras, 260 Unicode chars.
- Emojis limitados estrictamente a una lista permitida de 33 emojis y contados mediante `Intl.Segmenter` por grafema.
- 10 formas retóricas (5 slots de cada una) y 5 texturas (10 slots de cada una).
- Mezcla aleatoria mediante `node:crypto`.
- Distribución equilibrada entre posts si la campaña contiene múltiples URLs de X.
- El plan del slot se guarda inmutablemente en PostgreSQL antes de llamar a OpenAI.

## 8. Validación Local y Diversidad
Antes de aceptar un comentario generado:
- Se cargan hasta 20 comentarios recientes como contexto de diversidad para evitar repeticiones.
- Normalización: Unicode NFKC, minúsculas, eliminación de URLs, emojis y puntuación.
- Comprobación de hash SHA-256 para unicidad en la campaña (`UNIQUE(campaign_id, normalized_hash)`).
- Validación local: número de palabras, oraciones, recuento exacto de emojis, ausencia de URLs, solapamiento de palabras (< 60%), trigramas y primeras 4 palabras distintas.
- Admite hasta una reescritura correctiva por intento si falla la validación local.

## 9. Cola Persistente, Estados y Leases
- Cola en PostgreSQL mediante tablas `generation_cycles` y `generation_jobs`.
- Reclamación de trabajos mediante transacción con `FOR UPDATE SKIP LOCKED`.
- Asignación de `lease_owner` y expiración de lease (`lease_expires_at`).
- Reintentos con backoff exponencial hasta 3 intentos por trabajo.
- Estados de ciclo y trabajo: `pending`, `processing`, `completed`, `failed`.
- Un ciclo se completa únicamente cuando produce exactamente 50 sugerencias válidas.
- **Retirada de sugerencias**:
  - Las sugerencias en estado `available` pueden retirarse administrativamente (pasan a estado `withdrawn` con `withdrawn_at`).
  - La carrera entre retirada administrativa y asignación pública se resuelve atómicamente mediante `SELECT FOR UPDATE` en base de datos; la primera en procesarse gana, protegiendo la inmutabilidad si la sugerencia ya fue asignada.

## 10. Lotes y Reposición
- Inventario inicial: 50 sugerencias.
- Cuando el inventario disponible desciende a 20 o menos:
  - La comprobación y posible reposición se lanza asíncronamente de forma separada *después* de haber completado y cerrado la transacción de asignación o de retirar administrativamente una sugerencia, para evitar tiempos de respuesta lentos.
  - Se crea automáticamente un ciclo de reposición de 50 slots utilizando el snapshot actual de posts vigentes de la campaña.
  - La base de datos impide más de un ciclo activo por campaña mediante un bloqueo transaccional a nivel de fila sobre la propia campaña (`SELECT 1 FROM campaigns FOR UPDATE`). Esto provee una garantía real contra carreras concurrentes (ej. entre ediciones de posts y disparos de reposición).

## 11. Disparadores del Worker
- Creación de campaña o reposición arranca el worker en segundo plano mediante `after()` o ejecución asíncrona no bloqueante.
- Polling administrativo automático desde la interfaz de `/admin` mientras existan trabajos pendientes.
- Endpoint de disparo externo: `POST /api/internal/generation/process` protegido por `Authorization: Bearer {INTERNAL_PROCESS_SECRET}`.
- El worker también admite peticiones `GET` en la misma ruta, preparado para ser disparado por Vercel Cron (`vercel.json`) usando el mismo secreto (o configurando `CRON_SECRET` igual a `INTERNAL_PROCESS_SECRET` en Vercel).

## 12. Timeouts y Rollbacks
- Funciones Serverless de Next.js (Vercel): `maxDuration = 60` para rutas de generación.
- El presupuesto blando (`maxExecutionTimeMs`) del worker se fija en 50 segundos para que detenga su ciclo de forma limpia antes del `maxDuration` estricto.
- X API: 15 segundos (vía `AbortController`).
- OpenAI API: 60 segundos configurados en el cliente de `openai`.
- Consultas DB: 10 segundos (`statement_timeout`).
- Lock wait DB: 3 segundos (`lock_timeout`).
- Toda consulta que falle tras un `BEGIN` ejecuta de forma garantizada un `ROLLBACK` seguro mediante un bloque `try...catch` centralizado en `queryDb` para prevenir devolver conexiones con transacciones abiertas al pool.
- Lease de trabajo: 180 segundos (renovable) para dar margen a la reescritura de OpenAI.

## 13. Identidad por Cookie
- Cookie firmada con HMAC (`VISITOR_COOKIE_SECRET`): `__comment_app_vid`.
- Identificador aleatorio de 256 bits (32 bytes hex).
- Flags: `HttpOnly`, `Secure` en producción, `SameSite=Lax`, `Path=/`, 1 año de duración.
- En PostgreSQL se guarda solo el hash pseudonimizado (`SECURITY_HMAC_SECRET`) en la tabla `visitors`. Nunca se almacena la cookie original.
- Mismo navegador como límite de identidad. Borrar cookies puede producir una nueva asignación.

## 14. Rate Limit Público e Idempotencia
- Persistent DB rate limiting (`public_assignment_rate_limits`).
- Clave: HMAC de la IP + ventana temporal de 15 minutos (`SECURITY_HMAC_SECRET`).
- Máximo 30 peticiones por ventana de 15 minutos. Si se supera, devuelve `429` con el mensaje `Please try again`.
- Idempotencia pura: Si un visitante con asignación activa vuelve a solicitar un comentario para la misma campaña, recibe la asignación inmediatamente sin volver a consumir inventario, sin consultar el `rate limit` y sin incrementar los contadores.
- Un visitante puede poseer múltiples asignaciones históricas, pero solo una asignación *activa* a la vez, guardada en `visitor_campaign_states`.
- Si el visitante regresa incluso desde varias pestañas simultáneas sin haber pulsado "Post", todas las pestañas devuelven atómicamente la misma asignación activa gracias al bloqueo en base de datos.
- Las asignaciones previas históricas se conservan para siempre, garantizando que un post antiguo no se asigne de nuevo al mismo visitante y para mantener el registro inmutable.

## 15. Protección CSRF
- `POST /api/public/comment/[slug]/assignment` valida `Origin`, `Sec-Fetch-Site` y `Host` contra el origen de la aplicación.
- Peticiones cross-site son rechazadas.

## 16. Asignación Atómica y Rotación
- La apertura de `/comment/{slug}` mediante `GET` no asigna comentarios, no modifica PostgreSQL, no consume inventario y no registra visitantes.
- Los crawlers como Telegram preview reciben la página estática limpia sin consumir comentarios.
- El cliente ejecuta automáticamente un `POST /api/public/comment/[slug]/assignment` tras cargarse en el navegador.
- Transacción PostgreSQL con `SELECT FOR UPDATE SKIP LOCKED` para sugerencias y bloqueo `FOR UPDATE` en `visitor_campaign_states` para garantizar la sincronización exacta y evitar carreras de concurrencia.
- La rotación asegura que un mismo visitante nunca reciba dos sugerencias distintas para el mismo post dentro de una misma campaña.
- Si un post fue retirado, no participa en nuevas asignaciones, pero no rompe las asignaciones históricas ya entregadas.

## 17. Inmutabilidad en PostgreSQL
- Trigger y función `prevent_assignment_mutation()` que prohíbe operaciones `UPDATE` y `DELETE` en la tabla `assignments`.
- Trigger `prevent_click_mutation()` para hacer inmutable la tabla `assignment_post_clicks`.
- Claves foráneas con `ON DELETE RESTRICT`.

## 18. Vista Pública y Clic en Post
- Muestra estrictamente:
  `1. Tap “Copy”`
  `2. Tap “Post”`
  `3. Paste the comment and post it`
  Comentario como texto plano en un `div` no editable.
  Botones `Copy` y `Post`.
- Botón `Post` desactivado hasta pulsar `Copy`.
- `Copy` copia mediante Clipboard API y activa `Post`.
- `Post` abre de inmediato una pestaña vacía (para no ser bloqueado), notifica a `/api/public/comment/[slug]/assignment/complete` y navega a la URL de X devuelta de forma segura.
- Si la confirmación al servidor falla (por error de red, concurrencia o doble clic), la pestaña vacía se cierra y se muestra un error, sin perder la asignación ni consumir otra sugerencia.
- El registro de clic en la tabla inmutable indica únicamente que el visitante pulsó `Post` y avanzó de la asignación. No significa ni documenta confirmación real de que el usuario haya publicado en X.
- En campaña inactiva / slug inválido: muestra únicamente `Link expired`.
- Si no hay posts nuevos para el visitante: muestra únicamente `This link is currently unavailable. Please try again later.`.
- En errores temporales / sin stock de sugerencias / rate limit: muestra únicamente `Please try again`.

## 19. Base de Datos
- Neon PostgreSQL vía `@neondatabase/serverless` (WebSocket `Pool` para transacciones interactivas).
- En Vercel, los pools WebSocket no se reutilizan globalmente. Cada operación (consulta o transacción) crea, utiliza y cierra su propio pool individual para evitar errores de conexión terminada. Las transacciones interactivas siguen usando `PoolClient`.
- Tablas: `campaigns`, `campaign_posts`, `generation_cycles`, `generation_jobs`, `suggestions`, `visitors`, `assignments`, `admin_login_attempts`, `public_assignment_rate_limits`.

## 20. Autenticación Administrativa
- Hash `scrypt` de la contraseña guardado en `ADMIN_PASSWORD_HASH`.
- Cookie de sesión firmada `__comment_app_admin_session` (`ADMIN_SESSION_SECRET`).
- Rate limit de login: 5 fallos en 15 minutos bloquean el acceso durante 15 minutos.

## 21. Variables de Entorno
Documentadas exclusivamente en `.env.example`:
- `DATABASE_URL`
- `APP_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-5.4`
- `X_BEARER_TOKEN`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `VISITOR_COOKIE_SECRET`
- `SECURITY_HMAC_SECRET`
- `INTERNAL_PROCESS_SECRET`
- `CRON_SECRET` (Opcional, usado por Vercel para autorizar peticiones cron al worker. Debe ser idéntico a `INTERNAL_PROCESS_SECRET`).

## 22. Operación Local
1. `npm install`
2. Copiar `.env.example` a `.env.local` y configurar variables reales.
3. Generar hash de contraseña: `npm run admin:hash-password`
4. Configurar base de datos en Neon: `npm run db:setup`
5. Arrancar servidor de desarrollo: `npm run dev`

## 23. Despliegue Futuro y Cron
Compatible con Vercel / Node.js runtime. Requiere configurar variables de entorno en la plataforma de hosting y ejecutar `db:setup` en Neon.

**IMPORTANTE SOBRE VERCEL CRON**:
El archivo `vercel.json` estipula una ejecución programada (`* * * * *`) cada minuto. El plan gratuito "Hobby" de Vercel solo permite resoluciones Cron de como máximo una vez al día. Para usar este worker background en Vercel y que recoja trabajos cada minuto, **es estrictamente necesario usar un plan Vercel Pro o Enterprise**. De lo contrario, los procesos dependerán enteramente de disparos post-asignación o reintentos manuales. Además, si las llamadas conjuntas a OpenAI para la reescritura correctiva exceden los 60 segundos de forma constante, se requiere extender `maxDuration` en planes de Vercel superiores.

## 24. Limitaciones Conocidas
- Mismo navegador como límite de identidad: borrar cookies permite obtener un nuevo comentario.
- La IP no identifica visitantes, solo se usa pseudonimizada para seguridad anti-abuso.
- Telegram preview no consume comentarios.
- No hay publicación automática ni tracking de si el usuario publicó el comentario en X.
- No se realizaron pruebas de conexión o ejecución durante la creación del MVP.

## 25. Tipos de campaña

### Manual
* URLs concretas añadidas manualmente.
* Consulta X en la creación para obtener contenido del post.
* Ejecuta preflight de OpenAI para seguridad.
* Crea 50 slots iniciales tras la creación.
* Requiere el worker para generar las sugerencias.
* Gestión manual de posts.

### Perpetua
* Usa cuentas de X.
* Duración de posts entre 1 y 720 horas.
* Slug y URL pública permanentes.
* Creación sin posts, ciclos, jobs ni sugerencias iniciales.
* Creación sin llamadas a X ni OpenAI.
* Activación permitida cuando existe al menos una cuenta activa.
* URL pública activa sin posts devuelve `unavailable`.

## 26. Esquema de la Fase 2
* `campaigns.campaign_type`: 'manual' o 'perpetual'.
* `campaigns.post_active_lifetime_hours`: Duración en horas de los posts en campañas perpetuas.
* Tabla `campaign_accounts`: Guarda cuentas normalizadas asociadas a una campaña.
* `campaign_accounts.x_user_id`: Actualmente nullable y pendiente de resolución.
* `campaign_posts.campaign_account_id`: Referencia a la cuenta que originó el post.
* `campaign_posts.expires_at`: Fecha en la que expira un post en campaña perpetua.
* FK compuesta: `campaign_posts(campaign_account_id, campaign_id)` -> `campaign_accounts(id, campaign_id)`.
* Índices parciales sobre expiraciones y cuentas activas para eficiencia.

## 27. Cuentas de X
* Normalización estricta (minúsculas, rechazo de duplicados, etc.).
* Hosts exactos admitidos: `x.com`, `www.x.com`, `mobile.x.com`, `twitter.com`, `www.twitter.com`, `mobile.twitter.com`.
* Usernames de 1 a 15 caracteres.
* Retiro lógico usando `removed_at` (no existe borrado físico).
* Reañadir una cuenta retirada crea una fila nueva.
* Retirar una cuenta no retira sus posts existentes, estos permanecen activos hasta expirar.

## 28. Duración de posts perpetuos
* Recálculo desde `COALESCE(posted_at, created_at)` tras editar los settings.
* Acortar la duración puede retirar posts inmediatamente si su `expires_at` recae en el pasado.
* Ampliar prolonga posts todavía activos modificando su `expires_at`.
* Posts ya retirados nunca se reactivan, incluso si la duración es ampliada.

## 29. API administrativa de la Fase 2
* `POST /api/admin/campaigns/[id]/accounts`: Añadir cuentas.
* `DELETE /api/admin/campaigns/[id]/accounts/[accountId]`: Retirar una cuenta.
* `PATCH /api/admin/campaigns/[id]/settings`: Modificar la duración activa de los posts.

## 30. Funcionalidad pendiente para las Fases 3 y 4
Aún no están implementados:
* Filtered Stream (Las cuentas NO están siendo monitorizadas automáticamente aún).
* Resolución automática de `x_user_id`.
* Ingestión automática de nuevos posts.
* Catch-up (búsqueda inicial).
* Expiración programada.
* Generación automática al recibir posts.

*(La migración a base de datos de la Fase 2 todavía no se ha ejecutado).*

## 31. Terceros, Licencias Pendientes y Atribuciones
- Next.js (MIT)
- React (MIT)
- OpenAI SDK (Apache 2.0)
- `@neondatabase/serverless` (MIT)
- Zod (MIT)

## 32. Decisiones Importantes
- Selección de WebSocket Pool en `@neondatabase/serverless` para garantizar soporte completo de `BEGIN`, `FOR UPDATE SKIP LOCKED`, `COMMIT` y `ROLLBACK`.
- Asignación atómica en POST para evitar que bots o crawlers agoten inventario en vistas GET.
- Inmutabilidad estricta a nivel de trigger de base de datos para la tabla de asignaciones.

## 33. Historial de Cambios Documentados
- `v1.0.0`: Implementación completa inicial del MVP de Comment App.
- `v1.1.0`: Añadida edición de posts vigentes (`retired_at`), moderación de sugerencias (`withdrawn_at`), protección global del Referrer (`no-referrer`) y rutas administrativas anidadas (`/api/admin/campaigns/[id]/posts` y `/api/admin/campaigns/[id]/suggestions`).
- `Fixes`: Corregido bug de activación que impedía reactivar campañas con inventario disponible si había comentarios retirados o asignados (`src/lib/services.ts`). Corregido leak de la dirección administrativa hacia el output final modificando el system prompt y añadiendo validación local anti-copia literal (`src/lib/openai.ts`, `src/lib/validator.ts`, `src/lib/worker.ts`).
- `Fixes`: Corregido bug en `retryFailedCampaignJobs` que impedía reintentar trabajos si el ciclo no estaba en estado `failed`, buscando ahora el ciclo activo más antiguo con trabajos fallidos y reiniciándolos (`src/lib/services.ts`).
- `v1.2.0 (Fase 1)`: Implementada rotación segura de posts por visitante. Nuevas tablas (`visitor_campaign_states`, `assignment_post_clicks`) y reestructuración transaccional para garantizar inmutabilidad, idempotencia robusta y protección contra carreras. El botón `Post` ahora reserva la pestaña sincrónicamente y notifica avance para rotar al siguiente post en futuras visitas.
- `Fixes Fase 1`: Corrección quirúrgica implementando validación estricta de UUID en `/complete`, unificación en transacción única con bloqueo `FOR SHARE` en campañas para evitar carreras de retirada, validación rigurosa de pertenencia y estado activo antes de completar clics, bloqueo síncrono del cliente contra dobles clics evitando cierres prematuros, manejo seguro del fallback y reintento en UI, e idempotencia real en `setup-db.sql` utilizando verificaciones internas y claves foráneas compuestas.
- `v1.3.0 (Fase 2)`: Añadidas campañas manuales y perpetuas con `campaign_accounts` y duración configurable. Implementada gestión administrativa de cuentas y nuevos endpoints. Base de datos de `campaign_posts` preparada para cuenta de origen y expiración. Todavía sin Filtered Stream ni ingestión automática. Migración aún pendiente.
- `v1.3.1`: Corregido el ciclo de vida de las conexiones Neon en entornos serverless para evitar reutilizar conexiones WebSocket terminadas, creando y cerrando un pool local por cada transacción.
