/**
 * Homestead Configuration
 *
 * Manages user configuration stored in homestead-config.json
 * Key setting: CODE_DIR - where the user keeps their projects
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Config file lives in the homestead directory
const HOMESTEAD_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(HOMESTEAD_DIR, 'homestead-config.json');

// Default config
const DEFAULT_CONFIG = {
  codeDir: null,  // Must be set during onboarding
  setupComplete: false
};

/**
 * Load the current config
 * @returns {object} The config object
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    }
  } catch (err) {
    console.error('[Config] Error loading config:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save the config
 * @param {object} config - The config object to save
 */
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('[Config] Error saving config:', err.message);
    return false;
  }
}

/**
 * Get the CODE_DIR (where user keeps their projects)
 * @returns {string|null} The code directory path, or null if not set
 */
function getCodeDir() {
  const config = loadConfig();
  return config.codeDir;
}

/**
 * Set the CODE_DIR
 * @param {string} dir - The directory path
 * @returns {boolean} Success
 */
function setCodeDir(dir) {
  const config = loadConfig();
  config.codeDir = dir;
  config.setupComplete = true;
  return saveConfig(config);
}

/**
 * Check if setup is complete
 * @returns {boolean}
 */
function isSetupComplete() {
  const config = loadConfig();
  return config.setupComplete && config.codeDir !== null;
}

/**
 * Get common code directory suggestions based on the system
 * @returns {string[]} Array of suggested paths
 */
function getCodeDirSuggestions() {
  const home = os.homedir();
  const suggestions = [];

  // Common locations
  const possibleDirs = [
    path.join(home, 'code'),
    path.join(home, 'Code'),
    path.join(home, 'projects'),
    path.join(home, 'Projects'),
    path.join(home, 'dev'),
    path.join(home, 'Development'),
    path.join(home, 'src'),
    path.join(home, 'repos'),
    path.join(home, 'github'),
    path.join(home, 'workspace'),
    path.join(home, 'Documents', 'code'),
    path.join(home, 'Documents', 'projects'),
  ];

  // Check which ones actually exist
  for (const dir of possibleDirs) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        suggestions.push(dir);
      }
    } catch (e) {
      // Ignore permission errors etc
    }
  }

  return suggestions;
}

module.exports = {
  loadConfig,
  saveConfig,
  getCodeDir,
  setCodeDir,
  isSetupComplete,
  getCodeDirSuggestions,
  CONFIG_FILE,
  HOMESTEAD_DIR
};
