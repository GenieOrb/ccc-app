# Reparación Final E2E Real - Preview de 3 Memes

Se requiere solucionar de forma definitiva todos los bloqueos para que el canario E2E real pueda probar la aplicación y certificar que la preview de tres memes es apta para despliegue.

## Acciones Requeridas

1. **Limpieza de scripts temporales:**
   - Eliminar `rewrite_worker_memes.js`, ya que fue un script temporal y no está referenciado por ninguna otra parte del código ni package.json.

2. **Corrección de TypeScript / Linting:**
   - `src/lib/memes/generation.ts`:
     - Línea 155: Cambiar `let req` a `const req` ya que nunca se reasigna.
     - Líneas 167, 169: Cambiar `Promise<never>` y el cast `as any`. Para capturar la respuesta tipada debemos castearla correctamente o inferirla. (El SDK de Google devuelve `GenerateContentResponse`).
     - Línea 183: Tipar `p` en el `find` como `(p: Record<string, unknown>)` o lo que requiera el type para la inferencia.
   - `src/lib/worker.memes.ts`:
     - Línea 514: Cambiar `catch (e)` a `catch` o utilizar `e` sanitizado. Usaremos `catch` ya que el bloque lanza un error genérico y no necesita el original.

3. **Correcciones de la ruta del Worker Dirigido:**
   - `src/app/api/internal/generation/process/route.ts`:
     - Implementar variable `phase` con los valores requeridos (`authorization`, `body_validation`, `directed_meme_worker`, etc.).
     - Actualizar el log de error para mostrar el `mode` y `phase`, eliminando cualquier rastro de secretos o información no sanitizada (manteniendo el `Cache-Control: no-store`).
     - Asegurar el aislamiento total si llega un `memeCycleId`: saltar explícitamente `processPerpetualCampaigns`, `reconcileCampaignReplenishment`, `processBackgroundQueue` y dirigirse SOLO al worker de memes con `maxJobs = 3`.

4. **Corrección del Worker y Estado del Ciclo:**
   - `src/lib/worker.memes.ts`:
     - Renombrar y reimplementar `updateCycleStatus` a `recalculateMemeCycleStatus(cycleId)` tal como pide la auditoría.
     - Realizar una transacción (`FOR SHARE` en jobs y memes) para obtener el `target_count` del ciclo, contar el número exacto de *jobs* en cada estado y los *memes reales persistidos* (asociados a esos jobs).
     - Determinar el estado `completed` sólo si hay 3 jobs completed y exactamente 3 memes.
     - Eliminar cualquier uso de `meme_generation_cycles.updated_at` (columna inexistente en DB). Utilizar `MAX()` de `memes.created_at` o `jobs.updated_at` para progreso.

5. **Actualización de la UI y Status Route:**
   - `src/app/api/admin/meme-drafts/[draftId]/status/route.ts`:
     - Proveer todos los nuevos campos exigidos (e.g. `actualMemesCount`, `currentPhase`, `latestCallStatus`, `attemptsCount`, `progressUpdatedAt`) derivados del análisis en DB sin mezclar con otros ciclos ni usar `updated_at` de cycles.
   - `src/app/admin/page.tsx`:
     - Actualizar el temporizador de *polling*.
     - Abortar las llamadas con `AbortController` al iniciar un nuevo proceso.
     - Detener el *polling* cuando `actualMemesCount === 3`.
     - Mostrar los mensajes de error en estado parcial.

6. **Tests:**
   - `src/app/api/internal/generation/process/route.test.ts`: Utilizar un UUID fijo válido (e.g. `11111111-1111-4111-8111-111111111111`) en lugar de `test-cycle-uuid`.
   - Añadir tests adicionales en las otras rutas para cumplir la cobertura obligatoria de los fallos críticos señalada en el informe de la auditoría.

7. **Script Auditor E2E Real:**
   - Crear `scripts/audit-meme-preview-e2e.mjs` bajo ESM, importando dependencias como `pg` desde `node_modules` del proyecto.
   - Crear el wrapper shell `scripts/audit-meme-preview-e2e.sh` con `set -euo pipefail` ejecutando la secuencia exacta exigida (diff, typecheck, lint, test, build, comprobación `.next/BUILD_ID`, ejecución y parada del canario).
