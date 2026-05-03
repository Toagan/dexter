import { DynamicStructuredTool } from '@langchain/core/tools';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { loadCronStore, saveCronStore } from '../../cron/store.js';
import { computeNextRunAtMs } from '../../cron/schedule.js';
import { executeCronJob } from '../../cron/executor.js';
import type { CronJob, CronSchedule } from '../../cron/types.js';

/**
 * Build a CronSchedule from the flattened tool-input fields.
 * The schema is flattened (rather than a discriminated union) so the
 * generated JSON Schema stays a strict subset that Google Gemini accepts —
 * Gemini rejects `oneOf` + `const` patterns that discriminated unions emit.
 */
function buildScheduleFromInput(input: {
  schedule_kind?: 'at' | 'every' | 'cron';
  schedule_at?: string;
  schedule_every_ms?: number;
  schedule_anchor_ms?: number;
  schedule_cron_expr?: string;
  schedule_cron_tz?: string;
}): CronSchedule | { error: string } | undefined {
  if (!input.schedule_kind) return undefined;
  switch (input.schedule_kind) {
    case 'at': {
      if (!input.schedule_at) return { error: 'schedule_at (ISO-8601 timestamp) is required when schedule_kind=at' };
      return { kind: 'at', at: input.schedule_at };
    }
    case 'every': {
      if (input.schedule_every_ms === undefined) return { error: 'schedule_every_ms is required when schedule_kind=every' };
      if (input.schedule_every_ms < 60_000) return { error: 'schedule_every_ms minimum is 60000 (1 minute)' };
      return { kind: 'every', everyMs: input.schedule_every_ms, anchorMs: input.schedule_anchor_ms };
    }
    case 'cron': {
      if (!input.schedule_cron_expr) return { error: 'schedule_cron_expr is required when schedule_kind=cron' };
      return { kind: 'cron', expr: input.schedule_cron_expr, tz: input.schedule_cron_tz };
    }
  }
}

export const CRON_TOOL_DESCRIPTION = `
Manage scheduled/recurring tasks (cron jobs) that run automatically.
Jobs run as isolated agent turns with full tool access, delivering results via WhatsApp.

## When to Use

- User asks to set a recurring check, alert, or reminder
- User says things like "watch AAPL and tell me when it hits $200", "check earnings every morning", "remind me about the Fed meeting"
- User asks to see, modify, or cancel scheduled tasks
- User wants a one-time alert at a specific time

## Actions

- **list**: Show all scheduled jobs (enabled and disabled)
- **add**: Create a new scheduled job
- **update**: Modify an existing job (change schedule, prompt, fulfillment, or enable/disable)
- **remove**: Permanently delete a job
- **run**: Trigger a job immediately (useful for testing)

## Schedule

Pass the schedule as flat fields:

- **One-shot at a specific time:** \`schedule_kind: "at"\`, \`schedule_at: "2026-04-01T14:00:00Z"\`
- **Recurring interval (ms):** \`schedule_kind: "every"\`, \`schedule_every_ms: 3600000\` (1 hour); optional \`schedule_anchor_ms\`
- **Cron expression:** \`schedule_kind: "cron"\`, \`schedule_cron_expr: "0 9 * * 1-5"\`; optional \`schedule_cron_tz: "America/New_York"\`

## Fulfillment Modes

- **keep** (default): Job keeps running on schedule. For ongoing monitoring (e.g., "watch the market every hour").
- **once**: Auto-disables after the first alert is sent. For price targets and one-time notifications (e.g., "tell me when NVDA hits $150").
- **ask**: After alerting, asks the user if they want to continue watching.

## Message Prompt

The \`message\` field is the prompt the agent receives each time the job fires.
Write it as a clear instruction, e.g.: "Check the current price of AAPL. If it has moved more than 3% from $185, alert the user with the current price and percentage change."

## Tips

- Use \`list\` before modifying to see current job IDs
- For price watches, use fulfillment "once" so the user isn't spammed after the target is hit
- For daily/weekly checks, use cron expressions with the user's timezone
- The job prompt has full tool access (finance data, web search, etc.)
- Minimum interval for "every" schedules is 60 seconds
`.trim();

const cronToolSchema = z.object({
  action: z.enum(['list', 'add', 'update', 'remove', 'run']),
  name: z.string().optional().describe('Human-readable job name (required for add)'),
  description: z.string().optional().describe('Optional description'),

  // Flattened schedule (was z.discriminatedUnion — flattened so the generated
  // JSON Schema is a strict subset that Google Gemini accepts).
  schedule_kind: z
    .enum(['at', 'every', 'cron'])
    .optional()
    .describe('Schedule kind: "at" (one-shot), "every" (interval), "cron" (expression). Required for add.'),
  schedule_at: z
    .string()
    .optional()
    .describe('ISO-8601 timestamp (used when schedule_kind="at")'),
  schedule_every_ms: z
    .number()
    .optional()
    .describe('Interval in milliseconds, minimum 60000 = 1 minute (used when schedule_kind="every")'),
  schedule_anchor_ms: z
    .number()
    .optional()
    .describe('Optional anchor timestamp in ms (used when schedule_kind="every")'),
  schedule_cron_expr: z
    .string()
    .optional()
    .describe('Cron expression with 5 or 6 fields (used when schedule_kind="cron")'),
  schedule_cron_tz: z
    .string()
    .optional()
    .describe('IANA timezone (used when schedule_kind="cron", default: system timezone)'),

  message: z.string().optional().describe('Agent prompt for the job (required for add)'),
  model: z.string().optional().describe('Optional model override for job execution'),
  modelProvider: z.string().optional().describe('Optional model provider override'),
  fulfillment: z
    .enum(['keep', 'once', 'ask'])
    .optional()
    .describe('Fulfillment mode (default: keep)'),
  jobId: z.string().optional().describe('Job ID (required for update/remove/run)'),
  enabled: z.boolean().optional().describe('Enable/disable a job (for update)'),
});

export const cronTool = new DynamicStructuredTool({
  name: 'cron',
  description: 'Create, list, update, remove, or run scheduled jobs.',
  schema: cronToolSchema,
  func: async (input) => {
    switch (input.action) {
      case 'list': {
        const store = loadCronStore();
        if (store.jobs.length === 0) return 'No scheduled jobs.';
        return store.jobs.map(formatJobSummary).join('\n\n');
      }

      case 'add': {
        if (!input.name) return 'Error: name is required for add.';
        if (!input.message) return 'Error: message is required for add.';
        const built = buildScheduleFromInput(input);
        if (!built) return 'Error: schedule is required for add (set schedule_kind plus the matching field(s)).';
        if ('error' in built) return `Error: ${built.error}`;

        const store = loadCronStore();
        const now = Date.now();
        const id = randomBytes(8).toString('hex');
        const schedule = built;

        const nextRunAtMs = computeNextRunAtMs(schedule, now);
        if (nextRunAtMs === undefined && schedule.kind === 'at') {
          return 'Error: the specified time is in the past.';
        }

        const job: CronJob = {
          id,
          name: input.name,
          description: input.description,
          enabled: true,
          createdAtMs: now,
          updatedAtMs: now,
          schedule,
          payload: {
            message: input.message,
            model: input.model,
            modelProvider: input.modelProvider,
          },
          fulfillment: input.fulfillment ?? 'keep',
          state: {
            nextRunAtMs,
            consecutiveErrors: 0,
            scheduleErrorCount: 0,
          },
        };

        store.jobs.push(job);
        saveCronStore(store);

        const nextStr = nextRunAtMs ? new Date(nextRunAtMs).toISOString() : 'pending';
        return `Created job "${job.name}" (id: ${job.id}, fulfillment: ${job.fulfillment}). Next run: ${nextStr}`;
      }

      case 'update': {
        if (!input.jobId) return 'Error: jobId is required for update.';

        const store = loadCronStore();
        const job = store.jobs.find((j) => j.id === input.jobId);
        if (!job) return `Error: job ${input.jobId} not found.`;

        if (input.name !== undefined) job.name = input.name;
        if (input.description !== undefined) job.description = input.description;
        if (input.schedule_kind !== undefined) {
          const built = buildScheduleFromInput(input);
          if (built && 'error' in built) return `Error: ${built.error}`;
          if (built) {
            job.schedule = built;
            job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
            job.state.scheduleErrorCount = 0;
          }
        }
        if (input.message !== undefined) job.payload.message = input.message;
        if (input.model !== undefined) job.payload.model = input.model;
        if (input.modelProvider !== undefined) job.payload.modelProvider = input.modelProvider;
        if (input.fulfillment !== undefined) job.fulfillment = input.fulfillment;
        if (input.enabled !== undefined) {
          job.enabled = input.enabled;
          if (input.enabled && !job.state.nextRunAtMs) {
            job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
          }
          if (input.enabled) {
            job.state.consecutiveErrors = 0;
            job.state.scheduleErrorCount = 0;
          }
        }

        job.updatedAtMs = Date.now();
        saveCronStore(store);
        return `Updated job "${job.name}" (id: ${job.id}).`;
      }

      case 'remove': {
        if (!input.jobId) return 'Error: jobId is required for remove.';

        const store = loadCronStore();
        const idx = store.jobs.findIndex((j) => j.id === input.jobId);
        if (idx === -1) return `Error: job ${input.jobId} not found.`;

        const removed = store.jobs.splice(idx, 1)[0];
        saveCronStore(store);
        return `Removed job "${removed.name}" (id: ${removed.id}).`;
      }

      case 'run': {
        if (!input.jobId) return 'Error: jobId is required for run.';

        const store = loadCronStore();
        const job = store.jobs.find((j) => j.id === input.jobId);
        if (!job) return `Error: job ${input.jobId} not found.`;

        await executeCronJob(job, store, {});
        return `Job "${job.name}" executed. Status: ${job.state.lastRunStatus ?? 'unknown'}`;
      }

      default:
        return 'Unknown action. Use list, add, update, remove, or run.';
    }
  },
});

function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `one-shot at ${schedule.at}`;
    case 'every': {
      const secs = Math.round(schedule.everyMs / 1000);
      if (secs >= 3600) return `every ${Math.round(secs / 3600)}h`;
      if (secs >= 60) return `every ${Math.round(secs / 60)}m`;
      return `every ${secs}s`;
    }
    case 'cron':
      return `${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
  }
}

function formatJobSummary(job: CronJob): string {
  const status = job.enabled ? 'enabled' : 'DISABLED';
  const nextRun = job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : 'none';
  const lastRun = job.state.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : 'never';
  const lines = [
    `**${job.name}** (${job.id}) [${status}]`,
    `  Schedule: ${formatSchedule(job.schedule)}`,
    `  Fulfillment: ${job.fulfillment}`,
    `  Next run: ${nextRun}`,
    `  Last run: ${lastRun} (${job.state.lastRunStatus ?? 'never'})`,
  ];
  if (job.state.consecutiveErrors > 0) {
    lines.push(`  Errors: ${job.state.consecutiveErrors} consecutive`);
  }
  if (job.description) {
    lines.push(`  Description: ${job.description}`);
  }
  return lines.join('\n');
}
