import { NextRequest, NextResponse } from 'next/server';
import { appendFileSync } from 'fs';
import path from 'path';

const LOG_FILE = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/typing-debug.log';

export async function POST(request: NextRequest) {
  try {
    const { log } = await request.json();
    appendFileSync(LOG_FILE, log);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to write log:', error);
    return NextResponse.json({ error: 'Failed to write log' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const fs = require('fs');
    const logs = fs.readFileSync(LOG_FILE, 'utf-8');
    return NextResponse.json({ logs });
  } catch (error) {
    return NextResponse.json({ logs: '' });
  }
}
