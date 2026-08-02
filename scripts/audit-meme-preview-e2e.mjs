
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret';
const CRON_SECRET = process.env.CRON_SECRET || 'cron-only-secret';

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function startCanary() {
  console.log('[Canary] Iniciando prueba E2E de preview de memes...');

  // 1. Iniciar Preview
  console.log('[Canary] 1. Solicitando preview...');
  const previewPayload = {
    campaignType: 'manual',
    urlsInput: 'https://x.com/username/status/1234567890',
    direction: 'Canary Test Direction',
    memeModelKey: 'gemini-3.1-flash-image'
  };

  const previewRes = await fetch(`${API_BASE}/api/admin/campaigns/preview/memes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_SECRET}`
    },
    body: JSON.stringify(previewPayload)
  });

  if (!previewRes.ok) {
    throw new Error(`[Canary] Fallo en la petición de preview HTTP ${previewRes.status}`);
  }

  const previewData = await previewRes.json();
  if (!previewData.success || !previewData.draftId || !previewData.cycleId) {
    throw new Error('[Canary] No se recibieron los IDs requeridos');
  }

  const { draftId, cycleId } = previewData;
  console.log(`[Canary] Draft y Cycle creados: ${draftId} / ${cycleId}`);

  // 2. Simular trigger interno (en caso de que el trigger directo falle silenciosamente)
  console.log('[Canary] 2. Disparando Worker Dirigido explícitamente...');
  
  const triggerRes = await fetch(`${API_BASE}/api/internal/generation/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CRON_SECRET}`
    },
    body: JSON.stringify({ memeCycleId: cycleId })
  });
  
  if (!triggerRes.ok) {
     console.warn(`[Canary] El trigger devolvió HTTP ${triggerRes.status}, puede que no haya worker budget, continuando de todos modos.`);
  }

  // 3. Polling de status
  console.log('[Canary] 3. Esperando que el Worker complete el procesamiento...');
  let totalTime = 0;
  const POLL_INTERVAL = 3000;
  const MAX_TIME = 90_000;
  let finalMemes = [];
  
  while(totalTime < MAX_TIME) {
    const statusRes = await fetch(`${API_BASE}/api/admin/meme-drafts/${draftId}/status?cycleId=${cycleId}`, {
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` }
    });

    if (!statusRes.ok) {
       throw new Error(`[Canary] Fallo el polling de status: HTTP ${statusRes.status}`);
    }
    
    const statusData = await statusRes.json();
    const doneJobs = statusData.completedCount + statusData.failedCount + statusData.cancelledCount;
    const actualMemes = statusData.actualMemesCount || 0;
    
    console.log(`[Canary] Progreso: ${doneJobs}/${statusData.targetCount} jobs completados (Memes producidos: ${actualMemes})`);
    
    if (statusData.terminal || actualMemes === 3) {
       finalMemes = statusData.memes || [];
       if (finalMemes.length === 3) {
         console.log(`[Canary] ÉXITO: 3 memes completados correctamente.`);
         return 0;
       } else {
         throw new Error(`[Canary] Error: Se esperaban 3 memes, pero llegaron ${finalMemes.length}`);
       }
    }
    
    await delay(POLL_INTERVAL);
    totalTime += POLL_INTERVAL;
  }
  
  throw new Error(`[Canary] Timeout alcanzado sin terminar el ciclo.`);
}

startCanary().then(code => {
  process.exit(code || 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
