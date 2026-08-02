const fs = require('fs');

let content = fs.readFileSync('src/lib/worker.memes.ts', 'utf8');

content = content.replace(
  `    const queryParams: unknown[] = [workerId];\n    let cycleFilter = '';\n    if (cycleId) {\n      queryParams.push(cycleId);\n      cycleFilter = \`AND j.cycle_id = \$\${queryParams.length}\`;\n    }`,
  `    const queryParams: unknown[] = [];\n    let cycleFilter = '';\n    if (cycleId) {\n      queryParams.push(cycleId);\n      cycleFilter = \`AND j.cycle_id = $1\`;\n    }`
);

content = content.replace(
  `  const maxParallelConcurrency = options.maxConcurrency || 3;\n\n  const startTime = Date.now();`,
  `  const maxParallelConcurrency = options.maxConcurrency || 3;\n  const maxJobs = options.maxJobs;\n\n  const startTime = Date.now();`
);

content = content.replace(
  `  while (hasSafeJobBudget()) {\n    const claimedJobs: MemeClaimedJob[] = [];\n\n    for (let c = 0; c < maxParallelConcurrency; c++) {\n      if (!hasSafeJobBudget()) break;\n      const job = await claimNextMemeJob(workerId, cycleId);`,
  `  while (hasSafeJobBudget() && (maxJobs === undefined || totalProcessed < maxJobs)) {\n    const claimedJobs: MemeClaimedJob[] = [];\n\n    for (let c = 0; c < maxParallelConcurrency; c++) {\n      if (!hasSafeJobBudget()) break;\n      if (maxJobs !== undefined && (totalProcessed + claimedJobs.length) >= maxJobs) break;\n      const job = await claimNextMemeJob(workerId, cycleId);`
);

content = content.replace(
  `async function releaseLease(jobId: string) {\n  await queryDb(\n    \`UPDATE meme_generation_jobs\n     SET lease_owner = NULL, lease_expires_at = NULL\n     WHERE id = $1 AND status = 'processing'\`,\n    [jobId]\n  );\n}`,
  `async function releaseLease(jobId: string, transition: 'pending' | 'failed' | 'cancelled' = 'pending', errorMessage?: string) {\n  if (transition === 'pending') {\n    await queryDb(\n      \`UPDATE meme_generation_jobs\n       SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NOW() + INTERVAL '15 seconds', updated_at = NOW(), error_message = COALESCE($2, error_message)\n       WHERE id = $1 AND status = 'processing'\`,\n      [jobId, errorMessage || null]\n    );\n  } else if (transition === 'failed') {\n    await queryDb(\n      \`UPDATE meme_generation_jobs\n       SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, attempts_count = GREATEST(attempts_count, 3), updated_at = NOW(), error_message = COALESCE($2, error_message)\n       WHERE id = $1 AND status = 'processing'\`,\n      [jobId, errorMessage || null]\n    );\n  } else if (transition === 'cancelled') {\n    await queryDb(\n      \`UPDATE meme_generation_jobs\n       SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW(), error_message = COALESCE($2, error_message)\n       WHERE id = $1 AND status = 'processing'\`,\n      [jobId, errorMessage || null]\n    );\n  }\n}`
);

fs.writeFileSync('src/lib/worker.memes.ts', content);
console.log('Done 1');
