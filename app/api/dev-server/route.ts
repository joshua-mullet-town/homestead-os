import { NextRequest, NextResponse } from 'next/server';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getCodeDir } from '@/lib/get-code-dir';

const execAsync = promisify(exec);

// Track running dev servers by project name
const runningServers: Map<string, { pid: number; port: number }> = new Map();

interface ProjectInfo {
  name: string;
  path: string;
  type: 'nextjs' | 'node' | 'other';
  hasDevScript: boolean;
  devPort?: number;
}

/**
 * Detect project type and dev capabilities
 */
async function getProjectInfo(project: string): Promise<ProjectInfo | null> {
  const CODE_DIR = getCodeDir();
  const projectPath = path.join(CODE_DIR, project);

  if (!fs.existsSync(projectPath)) {
    return null;
  }

  const packageJsonPath = path.join(projectPath, 'package.json');
  const info: ProjectInfo = {
    name: project,
    path: projectPath,
    type: 'other',
    hasDevScript: false,
  };

  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Check for dev script
      if (packageJson.scripts?.dev) {
        info.hasDevScript = true;
      }

      // Detect Next.js
      if (packageJson.dependencies?.next || packageJson.devDependencies?.next) {
        info.type = 'nextjs';
        // Default Next.js port
        info.devPort = 3000;
      } else if (packageJson.scripts?.dev) {
        info.type = 'node';
      }

      // Try to detect custom port from dev script
      const devScript = packageJson.scripts?.dev || '';
      const portMatch = devScript.match(/(?:-p|--port)\s*(\d+)/);
      if (portMatch) {
        info.devPort = parseInt(portMatch[1]);
      }
    } catch (e) {
      // Ignore JSON parse errors
    }
  }

  return info;
}

/**
 * Check if a port is actually listening (most reliable method)
 */
async function isPortListening(port: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`lsof -i :${port} -P | grep LISTEN`).catch(() => ({ stdout: '' }));
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Find what process is listening on a port
 */
async function getProcessOnPort(port: number): Promise<{ pid: number; command: string } | null> {
  try {
    const { stdout } = await execAsync(`lsof -i :${port} -P | grep LISTEN | head -1`).catch(() => ({ stdout: '' }));
    if (stdout.trim()) {
      const parts = stdout.trim().split(/\s+/);
      // lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      return {
        pid: parseInt(parts[1]),
        command: parts[0],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a dev server is running for a project
 */
async function getServerStatus(project: string): Promise<{ running: boolean; pid?: number; port?: number }> {
  const projectInfo = await getProjectInfo(project);
  if (!projectInfo) {
    return { running: false };
  }

  // Get the expected port for this project
  const expectedPort = projectInfo.devPort || 3000;

  // Check our tracked servers first
  const tracked = runningServers.get(project);
  const portToCheck = tracked?.port || expectedPort;

  // Most reliable: check if something is actually listening on the port
  const listening = await isPortListening(portToCheck);

  if (listening) {
    const processInfo = await getProcessOnPort(portToCheck);
    if (processInfo) {
      // Update our tracking if we found it
      if (!tracked || tracked.pid !== processInfo.pid) {
        runningServers.set(project, { pid: processInfo.pid, port: portToCheck });
      }
      return { running: true, pid: processInfo.pid, port: portToCheck };
    }
  }

  // If we had a tracked server but port isn't listening, clean up
  if (tracked) {
    runningServers.delete(project);
  }

  return { running: false };
}

/**
 * GET - Get project info and server status
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const project = searchParams.get('project');

  if (!project) {
    return NextResponse.json({ error: 'Project name required' }, { status: 400 });
  }

  const projectInfo = await getProjectInfo(project);
  if (!projectInfo) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const serverStatus = await getServerStatus(project);

  return NextResponse.json({
    project: projectInfo,
    server: serverStatus,
  });
}

/**
 * POST - Start dev server
 */
export async function POST(request: NextRequest) {
  try {
    const { project, port } = await request.json();

    if (!project) {
      return NextResponse.json({ error: 'Project name required' }, { status: 400 });
    }

    const projectInfo = await getProjectInfo(project);
    if (!projectInfo) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    if (!projectInfo.hasDevScript) {
      return NextResponse.json({ error: 'Project has no dev script' }, { status: 400 });
    }

    // Check if already running
    const status = await getServerStatus(project);
    if (status.running) {
      return NextResponse.json({
        success: true,
        message: 'Server already running',
        pid: status.pid,
        port: status.port,
      });
    }

    // Start the dev server
    const targetPort = port || projectInfo.devPort || 3000;
    const devProcess = spawn('npm', ['run', 'dev'], {
      cwd: projectInfo.path,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(targetPort),
      },
    });

    devProcess.unref();

    if (devProcess.pid) {
      runningServers.set(project, { pid: devProcess.pid, port: targetPort });
    }

    // Wait a moment for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    const newStatus = await getServerStatus(project);

    return NextResponse.json({
      success: true,
      message: 'Dev server started',
      pid: newStatus.pid || devProcess.pid,
      port: newStatus.port || targetPort,
    });
  } catch (error) {
    console.error('Failed to start dev server:', error);
    return NextResponse.json({ error: 'Failed to start server' }, { status: 500 });
  }
}

/**
 * DELETE - Stop dev server
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const project = searchParams.get('project');

    if (!project) {
      return NextResponse.json({ error: 'Project name required' }, { status: 400 });
    }

    const status = await getServerStatus(project);
    if (!status.running || !status.pid) {
      return NextResponse.json({
        success: true,
        message: 'Server not running',
      });
    }

    // Kill the process and its children
    try {
      await execAsync(`kill -TERM -${status.pid} 2>/dev/null || kill ${status.pid}`);
    } catch {
      // Try harder
      await execAsync(`kill -9 ${status.pid}`).catch(() => {});
    }

    runningServers.delete(project);

    return NextResponse.json({
      success: true,
      message: 'Dev server stopped',
    });
  } catch (error) {
    console.error('Failed to stop dev server:', error);
    return NextResponse.json({ error: 'Failed to stop server' }, { status: 500 });
  }
}
