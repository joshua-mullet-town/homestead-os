import { NextRequest, NextResponse } from 'next/server';

let consoleLogs: Array<{ timestamp: number; message: string; data?: any }> = [];
const MAX_LOGS = 100;

export async function POST(request: NextRequest) {
  try {
    const { message, data } = await request.json();

    consoleLogs.push({
      timestamp: Date.now(),
      message,
      data,
    });

    // Keep only last MAX_LOGS entries
    if (consoleLogs.length > MAX_LOGS) {
      consoleLogs = consoleLogs.slice(-MAX_LOGS);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to log' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ logs: consoleLogs });
}
