// Simple script to generate SVG icons that can be converted to PNG
// For now, we'll use inline SVG data URLs

const fs = require('fs');
const path = require('path');

// Create a simple SVG icon (a dog/watchdog silhouette)
const svg192 = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="40" fill="#1a1a1a"/>
  <circle cx="96" cy="96" r="40" fill="#22c55e"/>
  <circle cx="96" cy="96" r="20" fill="#1a1a1a"/>
  <circle cx="96" cy="96" r="8" fill="#22c55e"/>
</svg>`;

const svg512 = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="100" fill="#1a1a1a"/>
  <circle cx="256" cy="256" r="120" fill="#22c55e"/>
  <circle cx="256" cy="256" r="60" fill="#1a1a1a"/>
  <circle cx="256" cy="256" r="24" fill="#22c55e"/>
</svg>`;

// Convert SVG to data URL for embedding
const toDataUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

console.log('192px icon data URL:');
console.log(toDataUrl(svg192));
console.log('\n512px icon data URL:');
console.log(toDataUrl(svg512));

// Write SVGs to public folder (browsers can use these)
fs.writeFileSync(path.join(__dirname, 'public', 'icon-192.svg'), svg192);
fs.writeFileSync(path.join(__dirname, 'public', 'icon-512.svg'), svg512);

console.log('\nSVG files written to public folder');
