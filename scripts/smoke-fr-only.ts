/**
 * One-shot smoke test for the FR-only build.
 * Boots the Agent with Gemini, runs a single query that exercises fr_research,
 * and prints events + final answer. Disposable script — feel free to delete.
 */
import 'dotenv/config';
import { Agent } from '../src/agent/index.js';

const QUERY = process.argv.slice(2).join(' ').trim() ||
  'Use fr_research to find ASML on FinancialReports, then list its 3 most recent filings (titles, types, release dates). Be concise.';
const MODEL = process.env.SMOKE_MODEL || 'gemini-flash-latest';

async function main() {
  const startedAt = Date.now();
  console.log(`[smoke] model=${MODEL}`);
  console.log(`[smoke] query=${QUERY}`);
  console.log('---');

  const agent = await Agent.create({
    model: MODEL,
    maxIterations: 6,
    memoryEnabled: false,
  });

  let finalAnswer = '';
  for await (const event of agent.run(QUERY)) {
    switch (event.type) {
      case 'thinking':
        if (event.message?.trim()) {
          console.log(`[think] ${event.message.slice(0, 200)}`);
        }
        break;
      case 'tool_start':
        console.log(`[tool→] ${event.tool} ${JSON.stringify(event.args).slice(0, 200)}`);
        break;
      case 'tool_end': {
        let preview = '';
        try {
          const parsed = JSON.parse(event.result);
          preview = JSON.stringify(parsed?.data ?? parsed).slice(0, 240);
        } catch {
          preview = String(event.result).slice(0, 240);
        }
        console.log(`[tool✓] ${event.tool} ${event.duration}ms — ${preview}`);
        break;
      }
      case 'tool_error':
        console.log(`[tool✗] ${event.tool} — ${event.error}`);
        break;
      case 'done':
        finalAnswer = event.answer ?? '';
        console.log(`[done] iterations=${event.iterations} totalMs=${event.totalTime}`);
        break;
      default:
        // ignore noisy events
        break;
    }
  }

  console.log('---');
  console.log('[answer]');
  console.log(finalAnswer || '(empty)');
  console.log(`---\n[smoke] elapsed=${Date.now() - startedAt}ms`);
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
