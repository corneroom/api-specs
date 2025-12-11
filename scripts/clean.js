#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Configuration
const CONFIG = {
  gatewayDir: path.resolve(__dirname, '../gateway'),
};

// Files to be removed
const patterns = [
  `${CONFIG.gatewayDir}/*.yaml`,
  // Exclude gateway-config.json
];

const directoriesToRemove = ['.generate'];

function cleanFiles() {
  let removedCount = 0;
  
  patterns.forEach(pattern => {
    const files = glob.sync(pattern);
    
    files.forEach(file => {
      try {
        fs.unlinkSync(file);
        console.log(`Removed: ${file}`);
        removedCount++;
      } catch (err) {
        console.error(`Error removing ${file}: ${err.message}`);
      }
    });
  });
  
  return removedCount;
}

function removeDirectory(directory) {
  const dirPath = path.resolve(__dirname, '..', directory);
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`Removed: ${dirPath}`);
  } else {
    console.log(`Directory not found: ${dirPath}`);
  }
}

// Main function
function main() {
  console.log('Cleaning generated files...');
  
  const removedCount = cleanFiles();
  
  directoriesToRemove.forEach(removeDirectory);

  if (removedCount > 0) {
    console.log(`\nSuccessfully removed ${removedCount} generated files.`);
  } else {
    console.log('\nNo files to clean.');
  }
}

// Run the main function
main();
