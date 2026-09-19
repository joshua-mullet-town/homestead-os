import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * GET /api/phone/status
 *
 * Check if phone is connected via ADB
 */
export async function GET() {
  try {
    const { stdout: output } = await execAsync('adb devices', {
      timeout: 5000
    });

    // Parse adb devices output
    // Format: "List of devices attached\n<device_id>\tdevice\n"
    const lines = output.trim().split('\n').slice(1); // Skip header
    const connectedDevices = lines.filter(line =>
      line.includes('device') && !line.includes('offline')
    );

    const connected = connectedDevices.length > 0;

    // Get device info if connected
    let deviceInfo = null;
    if (connected) {
      try {
        const { stdout: deviceOutput } = await execAsync('adb devices -l', {
          timeout: 5000
        });
        const deviceLine = deviceOutput.split('\n').find(l => l.includes('model:'));
        if (deviceLine) {
          const modelMatch = deviceLine.match(/model:(\S+)/);
          deviceInfo = {
            model: modelMatch ? modelMatch[1].replace(/_/g, ' ') : 'Unknown'
          };
        }
      } catch {
        // Ignore device info errors
      }
    }

    return NextResponse.json({
      connected,
      deviceCount: connectedDevices.length,
      device: deviceInfo
    });

  } catch (error) {
    console.error('[Phone Status] Error:', error);
    return NextResponse.json({
      connected: false,
      error: error instanceof Error ? error.message : 'Failed to check ADB status'
    });
  }
}
