import 'server-only';
import { randomUUID } from 'node:crypto';
import { processPerpetualCampaigns } from './perpetual-monitor';
import { reconcileCampaignReplenishment } from './services';
import { runGenerationProcessing } from './worker';

export async function runGlobalGenerationProcessing() {
  const started = Date.now();
  const monitor = await processPerpetualCampaigns(30000);
  const replenishment = await reconcileCampaignReplenishment();
  const generation = await runGenerationProcessing(randomUUID(), Math.max(0, 50000 - (Date.now() - started)));
  return { monitor, replenishment, ...generation };
}
