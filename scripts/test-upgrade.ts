import { Client } from 'pg';
import fs from 'fs';
import path from 'path';

async function main() {
  const client = new Client({
    connectionString: 'postgresql://postgres:postgres@localhost:5433/postgres'
  });

  await client.connect();

  try {
    console.log('1. Preparando esquema antiguo...');
    // Drop todo para un test limpio
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    // First, run the full current setup to create tables
    const setupSql = fs.readFileSync(path.join(process.cwd(), 'scripts/setup-db.sql'), 'utf-8');
    await client.query(setupSql);

    // Now, drop the unique constraint to simulate an older database state
    console.log('Simulating older DB without unique_cycle_id_slot_index constraint...');
    await client.query('ALTER TABLE meme_generation_jobs DROP CONSTRAINT IF EXISTS unique_cycle_id_slot_index');

    // Insertar datos para verificar conservación
    const resCamp = await client.query(`INSERT INTO campaigns (slug) VALUES ('test-campaign') RETURNING id`);
    const cId = resCamp.rows[0].id;

    const resPost = await client.query(`INSERT INTO campaign_posts (campaign_id, x_post_id, input_url, canonical_url, text_content) VALUES ($1, '123', 'url', 'url', 'test') RETURNING id`, [cId]);
    const cpId = resPost.rows[0].id;

    const resCycle = await client.query(`INSERT INTO meme_generation_cycles (campaign_id, campaign_post_id, cycle_type, model_key, provider, api_model, planner_version, pricing_snapshot, status) VALUES ($1, $2, 'initial', 'm', 'p', 'a', 1, '{}', 'completed') RETURNING id`, [cId, cpId]);
    const cycleId = resCycle.rows[0].id;
    
    const resJob = await client.query(`INSERT INTO meme_generation_jobs (cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan, deterministic_dimensions, model_snapshot, status) VALUES ($1, $2, $3, 0, '{}', '{}', '{}', 'completed') RETURNING id`, [cycleId, cId, cpId]);
    const jobId = resJob.rows[0].id;
    
    // We drop the constraint, so let's insert a duplicate to test if setup-db.sql catches it (it should throw an exception!)
    // Wait, the user wants us to "Compruebe que dos filas con el mismo cycle_id y slot_index son rechazadas." AFTER setup-db.sql runs!
    // So let's NOT insert a duplicate here, otherwise setup-db.sql will fail the idempotent check by throwing the RAISE EXCEPTION as designed.
    // We will test insertion later.

    const resMeme = await client.query(`
      INSERT INTO memes (campaign_id, campaign_post_id, job_id, status, storage_provider, storage_key, storage_url, mime_type, size_bytes, width, height, sha256_hash, slot_plan, model_key, delivery_order)
      VALUES ($1, $2, $3, 'available', 's3', 'k', 'u', 'image/jpeg', 100, 100, 100, 'hash', '{}', 'gpt-5.4', 1)
      RETURNING id
    `, [cId, cpId, jobId]);
    const memeId = resMeme.rows[0].id;

    console.log('2. Ejecutando setup-db.sql para simular el update que añade la constraint...');
    await client.query(setupSql);

    console.log('3. Validando estado del esquema (draft_id, NOT NULL retirados, checks y FKs)...');
    
    const columnsRes = await client.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'memes' AND column_name IN ('campaign_id', 'campaign_post_id', 'draft_id')
    `);
    const cols = columnsRes.rows.reduce((acc: Record<string, string>, row) => {
      acc[row.column_name] = row.is_nullable;
      return acc;
    }, {});

    if (!cols.draft_id) throw new Error('draft_id no se añadió');
    if (cols.campaign_id !== 'YES' || cols.campaign_post_id !== 'YES') throw new Error('NOT NULL no se retiró de campaign_id / campaign_post_id');

    const checkRes = await client.query(`
      SELECT pg_get_constraintdef(oid) as cdef
      FROM pg_constraint
      WHERE conrelid = 'meme_assets'::regclass AND contype = 'c' AND conname = 'meme_assets_appearance_percentage_check'
    `);
    if (!checkRes.rows[0].cdef.includes('>= 0')) throw new Error('Check de assets no actualizado a 0-100');

    const fkRes = await client.query(`
      SELECT pg_get_constraintdef(oid) as cdef
      FROM pg_constraint
      WHERE conrelid = 'assignments'::regclass AND contype = 'f' AND conname = 'fk_assignments_meme_compound'
    `);
    if (!fkRes.rows[0]?.cdef.includes('FOREIGN KEY (meme_id, campaign_id, campaign_post_id)')) {
      throw new Error('FK compuesta de assignments no existe o es incorrecta');
    }

    const dataCheck = await client.query(`SELECT id FROM memes WHERE id = $1`, [memeId]);
    if (dataCheck.rows.length === 0) throw new Error('Los datos históricos se perdieron!');

    console.log('4. Ejecutando setup-db.sql por segunda vez (idempotencia)...');
    await client.query(setupSql);
    console.log('Todo correcto: La segunda ejecución no arrojó errores de duplicación u otros.');
    
    // 6. Compruebe que dos filas con el mismo cycle_id y slot_index son rechazadas.
    console.log('5. Validando comportamiento de unique_cycle_id_slot_index...');
    try {
      await client.query(`INSERT INTO meme_generation_jobs (cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan, deterministic_dimensions, model_snapshot, status) VALUES ($1, $2, $3, 0, '{}', '{}', '{}', 'completed')`, [cycleId, cId, cpId]);
      throw new Error('Should have rejected duplicate cycle_id and slot_index');
    } catch (e: unknown) {
      if (e instanceof Error && !e.message.includes('duplicate key value violates unique constraint "unique_cycle_id_slot_index"')) {
        throw e;
      }
    }
    
    // 7. Compruebe que slots distintos del mismo ciclo son aceptados.
    await client.query(`INSERT INTO meme_generation_jobs (cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan, deterministic_dimensions, model_snapshot, status) VALUES ($1, $2, $3, 1, '{}', '{}', '{}', 'completed')`, [cycleId, cId, cpId]);
    
    // 8. Compruebe que el mismo slot en ciclos diferentes es aceptado.
    const resCycle2 = await client.query(`INSERT INTO meme_generation_cycles (campaign_id, campaign_post_id, cycle_type, model_key, provider, api_model, planner_version, pricing_snapshot, status) VALUES ($1, $2, 'initial', 'm', 'p', 'a', 1, '{}', 'completed') RETURNING id`, [cId, cpId]);
    const cycleId2 = resCycle2.rows[0].id;
    await client.query(`INSERT INTO meme_generation_jobs (cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan, deterministic_dimensions, model_snapshot, status) VALUES ($1, $2, $3, 0, '{}', '{}', '{}', 'completed')`, [cycleId2, cId, cpId]);

    console.log('Todas las pruebas de la constraint pasaron!');

    console.log('¡Prueba de migración completada con éxito!');
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Error en el test:', err);
  process.exit(1);
});
