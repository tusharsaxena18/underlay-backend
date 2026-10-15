

import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { BusinessModelAgent } from '../agents/businessModel/businessModelAgent';

async function runAgentTest() {
  console.log('=========================================');
  console.log(' Testing Business Model Agent (full pipeline)');
  console.log('=========================================\n');

  const agent = new BusinessModelAgent();

  const output = await agent.run({
    startup_name: 'UnderLay',
    document: path.join(process.cwd(), 'pitch_deck.pdf'),
    category: 'AI / startup diligence',
    stage: 'pre-seed',
    sector: 'ai_saas', // must match the sector keys in data/benchmarks.json for benchmark fallback
  });

  console.log(JSON.stringify(output, null, 2));
  console.log(`\nStatus: ${output.status} | confidence: ${output.confidence} | source_type: ${output.source_type}`);
  console.log(`Trace: .traces/${output.raw_trace_id}.json`);
}

runAgentTest().catch((err) => {
  console.error('Agent test crashed:', err);
  process.exit(1);
});