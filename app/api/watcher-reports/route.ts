import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const REPORTS_FILE = join(DATA_DIR, 'watcher-reports.json');

interface WatcherReport {
  id: string;
  session: string;
  timestamp: string;
  type: 'verified' | 'flagged' | 'responded' | 'info';
  summary: string;
  details?: string;
  action_taken?: string;
  needs_attention: boolean;
  dismissed?: boolean;
}

interface ReportsData {
  reports: WatcherReport[];
}

function loadReports(): ReportsData {
  try {
    if (existsSync(REPORTS_FILE)) {
      return JSON.parse(readFileSync(REPORTS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Error loading watcher reports:', err);
  }
  return { reports: [] };
}

function saveReports(data: ReportsData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(REPORTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving watcher reports:', err);
  }
}

/**
 * GET - Fetch recent reports
 * Query params:
 *   - limit: number of reports (default 20)
 *   - session: filter to specific session
 *   - needs_attention: filter to only those needing attention
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '20', 10);
  const session = searchParams.get('session');
  const needsAttention = searchParams.get('needs_attention') === 'true';

  const data = loadReports();
  let reports = data.reports;

  // Filter by session if requested
  if (session) {
    reports = reports.filter(r => r.session === session);
  }

  // Filter if requested
  if (needsAttention) {
    reports = reports.filter(r => r.needs_attention && !r.dismissed);
  }

  // Sort by timestamp descending, limit
  reports = reports
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  // Count needing attention
  const attentionCount = data.reports.filter(r => r.needs_attention && !r.dismissed).length;

  return NextResponse.json({
    reports,
    total: data.reports.length,
    needs_attention_count: attentionCount
  });
}

/**
 * POST - Submit a new watcher report
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields
    if (!body.session || !body.type || !body.summary) {
      return NextResponse.json(
        { error: 'Missing required fields: session, type, summary' },
        { status: 400 }
      );
    }

    // Create report
    const report: WatcherReport = {
      id: `${body.session}-${Date.now()}`,
      session: body.session,
      timestamp: body.timestamp || new Date().toISOString(),
      type: body.type,
      summary: body.summary,
      details: body.details,
      action_taken: body.action_taken,
      needs_attention: body.needs_attention ?? false,
      dismissed: false
    };

    // Save
    const data = loadReports();
    data.reports.push(report);

    // Keep only last 500 reports
    if (data.reports.length > 500) {
      data.reports = data.reports.slice(-500);
    }

    saveReports(data);

    console.log(`[WatcherReport] New report: ${report.type} for ${report.session} - ${report.summary}`);

    return NextResponse.json({ success: true, report });

  } catch (err) {
    console.error('Error creating watcher report:', err);
    return NextResponse.json(
      { error: 'Failed to create report' },
      { status: 500 }
    );
  }
}

/**
 * PATCH - Dismiss a report
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.id) {
      return NextResponse.json(
        { error: 'Missing report id' },
        { status: 400 }
      );
    }

    const data = loadReports();
    const report = data.reports.find(r => r.id === body.id);

    if (!report) {
      return NextResponse.json(
        { error: 'Report not found' },
        { status: 404 }
      );
    }

    report.dismissed = body.dismissed ?? true;
    saveReports(data);

    return NextResponse.json({ success: true, report });

  } catch (err) {
    console.error('Error updating watcher report:', err);
    return NextResponse.json(
      { error: 'Failed to update report' },
      { status: 500 }
    );
  }
}
