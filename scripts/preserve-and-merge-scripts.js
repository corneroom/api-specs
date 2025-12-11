#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Preserve existing test scripts from current Postman collections and merge into new collections
 */

class ScriptPreserver {
  constructor() {
    this.existingScripts = new Map();
  }

  /**
   * Extract scripts from existing Postman collection
   */
  extractScriptsFromCollection(collectionPath) {
    console.log(`📖 Extracting scripts from: ${collectionPath}`);
    
    if (!fs.existsSync(collectionPath)) {
      console.warn(`⚠️  Collection not found: ${collectionPath}`);
      return;
    }

    try {
      const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
      this.extractScriptsFromItem(collection.item || []);
      console.log(`✅ Extracted ${this.existingScripts.size} script entries`);
    } catch (error) {
      console.error(`❌ Error reading collection ${collectionPath}:`, error.message);
    }
  }

  /**
   * Recursively extract scripts from collection items
   */
  extractScriptsFromItem(items, parentPath = '') {
    for (const item of items) {
      const currentPath = parentPath ? `${parentPath}/${item.name}` : item.name;
      
      // Extract scripts from request
      if (item.request) {
        const scriptKey = this.createScriptKey(item.request.method, item.request.url?.path || item.request.url);
        
        if (item.event) {
          const scripts = {
            preRequest: item.event.find(e => e.listen === 'prerequest')?.script?.exec || [],
            test: item.event.find(e => e.listen === 'test')?.script?.exec || []
          };
          
          if (scripts.preRequest.length > 0 || scripts.test.length > 0) {
            this.existingScripts.set(scriptKey, {
              path: currentPath,
              method: item.request.method,
              url: item.request.url,
              scripts: scripts
            });
          }
        }
      }
      
      // Recursively process sub-items
      if (item.item && Array.isArray(item.item)) {
        this.extractScriptsFromItem(item.item, currentPath);
      }
    }
  }

  /**
   * Create a unique key for script matching
   */
  createScriptKey(method, url) {
    const urlPath = Array.isArray(url) ? url.join('/') : url;
    return `${method.toUpperCase()}:${urlPath}`;
  }

  /**
   * Merge preserved scripts into new collection
   */
  mergeScriptsIntoCollection(collectionPath) {
    console.log(`🔄 Merging scripts into: ${collectionPath}`);
    
    if (!fs.existsSync(collectionPath)) {
      console.warn(`⚠️  Collection not found: ${collectionPath}`);
      return 0;
    }

    try {
      const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
      const mergedCountRef = { count: 0 };
      
      this.mergeScriptsIntoItem(collection.item || [], mergedCountRef);
      
      // Write updated collection
      fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2));
      console.log(`✅ Merged ${mergedCountRef.count} script sets into collection`);
      
      return mergedCountRef.count;
    } catch (error) {
      console.error(`❌ Error merging scripts into ${collectionPath}:`, error.message);
      return 0;
    }
  }

  /**
   * Recursively merge scripts into collection items
   */
  mergeScriptsIntoItem(items, mergedCountRef) {
    for (const item of items) {
      // Merge scripts into request
      if (item.request) {
        const scriptKey = this.createScriptKey(item.request.method, item.request.url?.path || item.request.url);
        const existingScript = this.existingScripts.get(scriptKey);
        
        if (existingScript) {
          // Ensure event array exists
          if (!item.event) {
            item.event = [];
          }
          
          // Add pre-request script if it exists
          if (existingScript.scripts.preRequest.length > 0) {
            const preRequestEvent = item.event.find(e => e.listen === 'prerequest');
            if (preRequestEvent) {
              preRequestEvent.script.exec = existingScript.scripts.preRequest;
            } else {
              item.event.push({
                listen: 'prerequest',
                script: {
                  exec: existingScript.scripts.preRequest,
                  type: 'text/javascript'
                }
              });
            }
          }
          
          // Add test script if it exists
          if (existingScript.scripts.test.length > 0) {
            const testEvent = item.event.find(e => e.listen === 'test');
            if (testEvent) {
              testEvent.script.exec = existingScript.scripts.test;
            } else {
              item.event.push({
                listen: 'test',
                script: {
                  exec: existingScript.scripts.test,
                  type: 'text/javascript'
                }
              });
            }
          }
          
          mergedCountRef.count++;
          console.log(`  📝 Merged scripts for: ${existingScript.method} ${existingScript.path}`);
        }
      }
      
      // Recursively process sub-items
      if (item.item && Array.isArray(item.item)) {
        this.mergeScriptsIntoItem(item.item, mergedCountRef);
      }
    }
  }

  /**
   * Load existing collections and extract scripts
   */
  loadExistingScripts(existingCollectionsDir) {
    console.log(`📂 Loading existing scripts from: ${existingCollectionsDir}`);
    
    if (!fs.existsSync(existingCollectionsDir)) {
      console.warn(`⚠️  Existing collections directory not found: ${existingCollectionsDir}`);
      return;
    }

    const files = fs.readdirSync(existingCollectionsDir)
      .filter(file => file.endsWith('.postman_collection.json'));
    
    for (const file of files) {
      const filePath = path.join(existingCollectionsDir, file);
      this.extractScriptsFromCollection(filePath);
    }
  }

  /**
   * Load existing scripts from Postman API collections
   */
  async loadExistingScriptsFromPostman() {
    if (!process.env.POSTMAN_API_KEY) {
      throw new Error('POSTMAN_API_KEY environment variable is required');
    }

    const fetch = require('node-fetch');
    const apiKey = process.env.POSTMAN_API_KEY;
    
    try {
      // Get all collections from Postman API
      const response = await fetch('https://api.getpostman.com/collections', {
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Postman API error: ${response.status}`);
      }

      const data = await response.json();
      const collections = data.collections || [];

      // Look for the most recent timestamped collections (latest generated)
      const gatewayTypes = ['app', 'dashboard'];
      
      for (const gatewayType of gatewayTypes) {
        // Find all timestamped collections for this gateway type
        const timestampedCollections = collections.filter(col => 
          col.name.includes('-staging-') && col.name.startsWith(gatewayType + '-')
        );
        
        if (timestampedCollections.length > 0) {
          // Sort by timestamp (most recent first)
          const mostRecent = timestampedCollections.sort((a, b) => {
            const timestampA = a.name.split('-staging-')[1];
            const timestampB = b.name.split('-staging-')[1];
            return new Date(timestampB) - new Date(timestampA);
          })[0];
          
          console.log(`📥 Found most recent collection: ${mostRecent.name}`);
          
          // Fetch the full collection data
          const collectionResponse = await fetch(`https://api.getpostman.com/collections/${mostRecent.uid}`, {
            headers: {
              'X-API-Key': apiKey,
              'Content-Type': 'application/json'
            }
          });

          if (collectionResponse.ok) {
            const collectionData = await collectionResponse.json();
            this.extractScriptsFromCollectionData(collectionData.collection, mostRecent.name);
          }
        } else {
          // Fallback to base collection if no timestamped collections exist
          const baseName = gatewayType === 'app' ? 'App API Gateway' : 'Dashboard API Gateway';
          const baseCollection = collections.find(col => col.name === baseName);
          
          if (baseCollection) {
            console.log(`📥 Found base collection (fallback): ${baseCollection.name}`);
            
            const collectionResponse = await fetch(`https://api.getpostman.com/collections/${baseCollection.uid}`, {
              headers: {
                'X-API-Key': apiKey,
                'Content-Type': 'application/json'
              }
            });

            if (collectionResponse.ok) {
              const collectionData = await collectionResponse.json();
              this.extractScriptsFromCollectionData(collectionData.collection, baseCollection.name);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Error loading collections from Postman API:', error.message);
      throw error;
    }
  }

  /**
   * Extract scripts from collection data (from API response)
   */
  extractScriptsFromCollectionData(collection, collectionName) {
    if (!collection.item) return;

    this.extractScriptsFromItem(collection.item, collectionName);
  }
}

async function main() {
  console.log('🔄 Starting script preservation and merging...');
  
  const scriptPreserver = new ScriptPreserver();
  let scriptsLoaded = false;
  let totalScriptsPreserved = 0;
  
  // Load existing scripts from Postman API collections
  try {
    await scriptPreserver.loadExistingScriptsFromPostman();
    scriptsLoaded = true;
    totalScriptsPreserved = scriptPreserver.existingScripts.size;
    console.log(`📊 Loaded ${totalScriptsPreserved} script entries from existing collections`);
  } catch (error) {
    console.warn('⚠️  Could not load existing scripts from Postman API:', error.message);
    console.log('🔄 Continuing without script preservation...');
  }
  
  // Merge scripts into new collections
  const newCollectionsDir = path.resolve(__dirname, '..', 'postman-collections');
  const files = fs.readdirSync(newCollectionsDir)
    .filter(file => file.endsWith('.postman_collection.json'));
  
  let totalMerged = 0;
  for (const file of files) {
    const filePath = path.join(newCollectionsDir, file);
    const mergedCount = scriptPreserver.mergeScriptsIntoCollection(filePath);
    totalMerged += mergedCount;
  }
  
  console.log('✅ Script preservation and merging completed!');
  
  // Return success status
  const success = scriptsLoaded && totalScriptsPreserved > 0 && totalMerged > 0;
  if (!success) {
    console.warn('⚠️  Script preservation validation failed:');
    console.warn(`   - Scripts loaded: ${scriptsLoaded}`);
    console.warn(`   - Scripts found: ${totalScriptsPreserved}`);
    console.warn(`   - Scripts merged: ${totalMerged}`);
  }
  
  return success;
}

if (require.main === module) {
  (async () => {
    try {
      const success = await main();
      if (!success) {
        console.error('❌ Script preservation validation failed - collections will not be pushed to Postman');
        process.exit(1); // Exit with error to prevent pushing
      }
    } catch (error) {
      console.error('⚠️  Postman script preservation failed:', error.message);
      console.error('🔄 Continuing workflow without Postman updates...');
      process.exit(1); // Exit with error to prevent pushing
    }
  })();
}

module.exports = { ScriptPreserver };
