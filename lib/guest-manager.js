const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');
const os = require('os');

const HOMESTEAD_DIR = join(os.homedir(), '.homestead');
const CONFIG_FILE = join(HOMESTEAD_DIR, 'guests.json');

function ensureDir() {
  if (!existsSync(HOMESTEAD_DIR)) {
    mkdirSync(HOMESTEAD_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) {
    const defaults = { owner: 'joshuamullet@gmail.com', guests: [] };
    writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));

  // Auto-migrate old flat sessionName format to new sharedSession/personalSessions format
  let migrated = false;
  for (const guest of config.guests) {
    if (guest.sessionName && !guest.sharedSession) {
      guest.sharedSession = {
        sessionName: guest.sessionName,
        sessionDir: guest.sessionDir || join(HOMESTEAD_DIR, 'guest-sessions', guest.shortName || guest.login.split('@')[0].replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()),
      };
      guest.personalSessions = [];
      // Derive shortName if missing
      if (!guest.shortName) {
        guest.shortName = guest.login.split('@')[0].replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      }
      delete guest.sessionName;
      delete guest.sessionDir;
      migrated = true;
    }
  }
  if (migrated) {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }

  return config;
}

function saveConfig(config) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getGuestByLogin(login) {
  const config = loadConfig();
  return config.guests.find(g => g.login === login) || null;
}

function addGuest({ login, name, profilePic }) {
  const config = loadConfig();
  if (config.guests.find(g => g.login === login)) {
    return { error: 'Guest already exists' };
  }
  // Derive short name from login (before @)
  const shortName = login.split('@')[0].replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const guest = {
    login,
    name: name || shortName,
    shortName,
    profilePic: profilePic || null,
    sharedSession: {
      sessionName: `holler-guest-${shortName}`,
      sessionDir: join(HOMESTEAD_DIR, 'guest-sessions', shortName),
    },
    personalSessions: [],
    projects: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    lastSeen: null,
  };
  config.guests.push(guest);
  saveConfig(config);
  return { guest };
}

function removeGuest(login) {
  const config = loadConfig();
  config.guests = config.guests.filter(g => g.login !== login);
  saveConfig(config);
}

function toggleGuest(login, enabled) {
  const config = loadConfig();
  const guest = config.guests.find(g => g.login === login);
  if (guest) {
    guest.enabled = enabled;
    saveConfig(config);
  }
  return guest;
}

function updateLastSeen(login) {
  const config = loadConfig();
  const guest = config.guests.find(g => g.login === login);
  if (guest) {
    guest.lastSeen = new Date().toISOString();
    saveConfig(config);
  }
}

/**
 * Resolve identity from request headers.
 * Returns { role: 'owner'|'guest'|'unknown', login, name, profilePic, sessionName }
 */
function getIdentity(req) {
  const tsLogin = req.headers['tailscale-user-login'];
  const tsName = req.headers['tailscale-user-name'];
  const tsPic = req.headers['tailscale-user-profile-pic'];

  // Get remote address (handle both ::ffff:127.0.0.1 and 127.0.0.1)
  const remoteIp = (req.socket?.remoteAddress || '').replace('::ffff:', '');

  const config = loadConfig();

  // Case 1: Request from localhost with Tailscale headers → trust headers
  const isLocalhost = remoteIp === '127.0.0.1' || remoteIp === '::1';
  if (isLocalhost && tsLogin) {
    if (tsLogin === config.owner) {
      return { role: 'owner', login: tsLogin, name: tsName || 'Owner', profilePic: tsPic || null, sessionName: null };
    }
    const guest = config.guests.find(g => g.login === tsLogin && g.enabled);
    if (guest) {
      updateLastSeen(tsLogin);
      return {
        role: 'guest',
        login: guest.login,
        name: guest.name,
        shortName: guest.shortName,
        profilePic: guest.profilePic || tsPic || null,
        sharedSession: guest.sharedSession,
        personalSessions: guest.personalSessions || [],
      };
    }
    return { role: 'unknown', login: tsLogin, name: tsName || null, profilePic: tsPic || null, sessionName: null };
  }

  // Case 2: LAN access with no Tailscale headers → owner (backwards compat)
  const isLan = isLocalhost || remoteIp.startsWith('10.') || remoteIp.startsWith('100.');
  if (isLan && !tsLogin) {
    return { role: 'owner', login: config.owner, name: 'Owner', profilePic: null, sessionName: null };
  }

  // Case 3: Anything else → unknown
  return { role: 'unknown', login: tsLogin || null, name: tsName || null, profilePic: tsPic || null, sessionName: null };
}

function getOwnerName() {
  const config = loadConfig();
  // Derive from owner email
  const ownerLogin = config.owner || '';
  const local = ownerLogin.split('@')[0] || 'Josh';
  // Capitalize first letter
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function addPersonalSession(login, name) {
  const config = loadConfig();
  const guest = config.guests.find(g => g.login === login);
  if (!guest) return { error: 'Guest not found' };
  if (!guest.personalSessions) guest.personalSessions = [];
  if (guest.personalSessions.length >= 5) return { error: 'Maximum 5 personal sessions allowed' };

  // Validate name: lowercase alphanumeric + hyphens only
  const cleanName = name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  if (!cleanName) return { error: 'Invalid session name' };
  if (guest.personalSessions.find(s => s.name === cleanName)) return { error: 'Session already exists' };

  const session = {
    name: cleanName,
    sessionName: `holler-gp-${guest.shortName}-${cleanName}`,
    sessionDir: join(HOMESTEAD_DIR, 'guest-sessions', guest.shortName, cleanName),
  };
  guest.personalSessions.push(session);
  saveConfig(config);
  return { session };
}

function setGuestProjects(login, projects) {
  const config = loadConfig();
  const guest = config.guests.find(g => g.login === login);
  if (!guest) return { error: 'Guest not found' };
  // projects is an array of { name, path, description? }
  guest.projects = projects;
  saveConfig(config);
  return { success: true };
}

function getGuestProjects(login) {
  const config = loadConfig();
  const guest = config.guests.find(g => g.login === login);
  if (!guest) return [];
  return guest.projects || [];
}

function removePersonalSession(login, name) {
  const config = loadConfig();
  const guest = config.guests.find(g => g.login === login);
  if (!guest) return { error: 'Guest not found' };
  if (!guest.personalSessions) return { error: 'No personal sessions' };

  const before = guest.personalSessions.length;
  guest.personalSessions = guest.personalSessions.filter(s => s.name !== name);
  if (guest.personalSessions.length === before) return { error: 'Session not found' };

  saveConfig(config);
  return { success: true };
}

module.exports = {
  loadConfig,
  saveConfig,
  getGuestByLogin,
  addGuest,
  removeGuest,
  toggleGuest,
  updateLastSeen,
  getIdentity,
  getOwnerName,
  addPersonalSession,
  removePersonalSession,
  setGuestProjects,
  getGuestProjects,
  HOMESTEAD_DIR,
  CONFIG_FILE,
};
