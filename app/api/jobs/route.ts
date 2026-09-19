import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const JOB_LOGS_DIR = join(process.cwd(), 'data', 'job-logs');

// The job scheduler is initialized in server.js and exposed globally
declare global {
  var jobScheduler: {
    addRecurringJob: (params: {
      id: string;
      type: string;
      cron: string;
      config?: any;
      enabled?: boolean;
    }) => any;
    removeRecurringJob: (id: string) => boolean;
    listRecurringJobs: () => any[];
    setJobEnabled: (id: string, enabled: boolean) => boolean;
    executeJob: (job: any) => void;
    isGloballyEnabled: () => boolean;
    setGlobalGate: (enabled: boolean) => void;
  } | undefined;
}

interface JobLog {
  job_id: string;
  ran_at: string;
  output: string | null;
  error: string | null;
}

/**
 * GET /api/jobs
 * List all recurring jobs with their last run logs
 */
export async function GET() {
  try {
    if (!global.jobScheduler) {
      return NextResponse.json(
        { error: 'Job scheduler not initialized' },
        { status: 503 }
      );
    }

    const jobs = global.jobScheduler.listRecurringJobs();

    // Attach last log to each job
    const jobsWithLogs = jobs.map((job: { id: string }) => {
      const logFile = join(JOB_LOGS_DIR, `${job.id}.json`);
      let lastLog: JobLog | null = null;

      if (existsSync(logFile)) {
        try {
          lastLog = JSON.parse(readFileSync(logFile, 'utf-8'));
        } catch {
          // Ignore parse errors
        }
      }

      return {
        ...job,
        last_log: lastLog
      };
    });

    const globalEnabled = global.jobScheduler.isGloballyEnabled();

    return NextResponse.json({ jobs: jobsWithLogs, globalEnabled });
  } catch (error) {
    console.error('[API] Error listing jobs:', error);
    return NextResponse.json(
      { error: 'Failed to list jobs' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/jobs
 * Create a new recurring job
 *
 * Body: {
 *   id: string,           // Unique identifier
 *   type: string,         // Job type: 'memory-harvester', 'command', 'script'
 *   cron: string,         // Cron expression (e.g., '0,15,30,45 * * * *' for every 15 min)
 *   config?: object,      // Type-specific configuration
 *   enabled?: boolean     // Whether to start the job immediately (default: true)
 * }
 *
 * Job types:
 * - 'memory-harvester': { minutes?: number } - minutes lookback window
 * - 'command': { command: string, cwd?: string }
 * - 'script': { script: string, args?: string[] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, type, cron, config, enabled } = body;

    // Validate required fields
    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'id is required and must be a string' },
        { status: 400 }
      );
    }

    if (!type || typeof type !== 'string') {
      return NextResponse.json(
        { error: 'type is required and must be a string' },
        { status: 400 }
      );
    }

    if (!cron || typeof cron !== 'string') {
      return NextResponse.json(
        { error: 'cron is required and must be a valid cron expression' },
        { status: 400 }
      );
    }

    // Validate job type
    const validTypes = ['memory-harvester', 'command', 'script', 'location-reminder', 'notification-check', 'session-stuck'];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: `type must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    if (!global.jobScheduler) {
      return NextResponse.json(
        { error: 'Job scheduler not initialized' },
        { status: 503 }
      );
    }

    const job = global.jobScheduler.addRecurringJob({
      id,
      type,
      cron,
      config,
      enabled: enabled !== false
    });

    return NextResponse.json(job);
  } catch (error) {
    console.error('[API] Error creating job:', error);
    return NextResponse.json(
      { error: 'Failed to create job' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/jobs?id=xxx
 * Remove a recurring job
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'id parameter is required' },
        { status: 400 }
      );
    }

    if (!global.jobScheduler) {
      return NextResponse.json(
        { error: 'Job scheduler not initialized' },
        { status: 503 }
      );
    }

    const removed = global.jobScheduler.removeRecurringJob(id);
    return NextResponse.json({ success: removed, id });
  } catch (error) {
    console.error('[API] Error removing job:', error);
    return NextResponse.json(
      { error: 'Failed to remove job' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/jobs?id=xxx
 * Enable/disable a job OR run it immediately
 *
 * Body: { enabled: boolean } - to enable/disable
 * Body: { runNow: true } - to execute immediately
 */
export async function PATCH(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'id parameter is required' },
        { status: 400 }
      );
    }

    if (!global.jobScheduler) {
      return NextResponse.json(
        { error: 'Job scheduler not initialized' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { enabled, runNow } = body;

    // Handle run now
    if (runNow === true) {
      const jobs = global.jobScheduler.listRecurringJobs();
      const job = jobs.find((j: any) => j.id === id);
      if (!job) {
        return NextResponse.json(
          { error: 'Job not found' },
          { status: 404 }
        );
      }
      global.jobScheduler.executeJob(job);
      return NextResponse.json({ success: true, id, action: 'executed' });
    }

    // Handle enable/disable
    if (typeof enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled must be a boolean, or use runNow: true' },
        { status: 400 }
      );
    }

    const success = global.jobScheduler.setJobEnabled(id, enabled);
    return NextResponse.json({ success, id, enabled });
  } catch (error) {
    console.error('[API] Error updating job:', error);
    return NextResponse.json(
      { error: 'Failed to update job' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/jobs
 * Global gate toggle. Individual per-job enabled flags are NEVER modified.
 * When the global gate is off, NO jobs fire regardless of individual state.
 * When it's on, jobs fire according to their own enabled flag.
 *
 * Body: { globalEnabled: boolean }
 */
export async function PUT(request: NextRequest) {
  try {
    if (!global.jobScheduler) {
      return NextResponse.json(
        { error: 'Job scheduler not initialized' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { globalEnabled } = body;

    if (typeof globalEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Body must include globalEnabled: boolean' },
        { status: 400 }
      );
    }

    global.jobScheduler.setGlobalGate(globalEnabled);
    return NextResponse.json({ success: true, globalEnabled });
  } catch (error) {
    console.error('[API] Error toggling global gate:', error);
    return NextResponse.json(
      { error: 'Failed to toggle global gate' },
      { status: 500 }
    );
  }
}
