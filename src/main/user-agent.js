/**
 * Centralized User-Agent string configuration
 * Follows Eve Online ESI best practices for third-party applications
 * Format: "AppName/Version (contact; character; +repo_url)"
 */

const { app } = require('electron');

/**
 * Get the properly formatted User-Agent string for ESI API calls
 * @returns {string} User-Agent string
 */
function getUserAgent() {
  const version = app.getVersion();
  const appName = 'Quantum Forge';
  const contact = 'roshcar@gmail.com';
  const character = 'eve:Roshcar';
  const repository = 'https://github.com/UserName/QuantumForge';

  return `${appName}/${version} (${contact}; ${character}; +${repository})`;
}

module.exports = {
  getUserAgent
};
