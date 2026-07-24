# Comment App

Aplicación independiente para la creación de campañas basadas en posts de X (Twitter), generación determinista de inventarios de comentarios únicos en inglés mediante GPT-5.4 y distribución atómica y exclusiva a visitantes.

## Propósito
Entregar a cada visitante de un enlace de campaña un único par indivisible `{post concreto de X + comentario exclusivo}`, garantizando que cada comentario pertenezca a un solo visitante.

## Requisitos
- Node.js 18+ o superior.
- npm (exclusivamente).
- Cuenta y base de datos en Neon PostgreSQL.
- API Key de OpenAI con acceso al modelo `gpt-5.4`.
- Bearer Token de la API v2 oficial de X.

## Scripts Disponibles
- `npm run dev`: Inicia el servidor de desarrollo de Next.js.
- `npm run build`: Compila la aplicación para producción.
- `npm run start`: Inicia el servidor de producción.
- `npm run lint`: Ejecuta las verificaciones de ESLint.
- `npm run typecheck`: Ejecuta la verificación de tipos de TypeScript.
- `npm run db:setup`: Ejecuta el script SQL transaccional de configuración de la base de datos en Neon.
- `npm run admin:hash-password`: Genera de forma interactiva y segura el hash `scrypt` para la contraseña de administración.

## Orden Futuro de Configuración
1. Clonar o acceder al directorio del proyecto.
2. Copiar `.env.example` a `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
3. Crear una base de datos en Neon PostgreSQL y copiar el `DATABASE_URL` en `.env.local`.
4. Obtener las credenciales de OpenAI (`OPENAI_API_KEY`) y X (`X_BEARER_TOKEN`) y configurarlas en `.env.local`.
5. Generar la contraseña del panel administrativo:
   ```bash
   npm run admin:hash-password
   ```
   Copiar la salida generada a la variable `ADMIN_PASSWORD_HASH` en `.env.local`.
6. Configurar los secretos aleatorios (`ADMIN_SESSION_SECRET`, `VISITOR_COOKIE_SECRET`, `SECURITY_HMAC_SECRET`, `INTERNAL_PROCESS_SECRET`).
7. Si el despliegue es en Vercel, configurar `CRON_SECRET` (recomendable usar el mismo valor que `INTERNAL_PROCESS_SECRET`) para habilitar la ejecución programada del worker.
8. Ejecutar el setup inicial de la base de datos:
   ```bash
   npm run db:setup
   ```
9. Iniciar la aplicación en desarrollo o compilar para producción:
   ```bash
   npm run dev
   ```

## Variables de Entorno y Vercel
Consulta el archivo `.env.example` para ver la lista completa de variables y descripciones.
La aplicación incluye un archivo `vercel.json` preparado para ejecutar el worker de generación automáticamente cada minuto utilizando Vercel Cron. Las funciones Serverless están configuradas para un máximo de 60 segundos (`maxDuration = 60`).

> [!WARNING]
> **ADVERTENCIA DE SEGURIDAD**: Nunca incluyas ni hagas commit de archivos con claves reales (`.env`, `.env.local`) en el repositorio. Asegúrate de mantener los secretos protegidos en tus entornos de desarrollo y producción.
