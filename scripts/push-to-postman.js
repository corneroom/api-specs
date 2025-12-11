#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Push Postman collections to Postman API
 */

const POSTMAN_API_BASE = 'https://api.getpostman.com';

class PostmanAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    };
  }

  async makeRequest(endpoint, options = {}) {
    const url = `${POSTMAN_API_BASE}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Postman API error: ${response.status} ${error}`);
    }

    return response.json();
  }

  /**
   * Get all workspaces
   */
  async getWorkspaces() {
    const result = await this.makeRequest('/workspaces');
    return result.workspaces || [];
  }

  /**
   * Get all collections (optionally filtered by workspace)
   */
  async getCollections(workspaceId = null) {
    const endpoint = workspaceId ? `/collections?workspace=${workspaceId}` : '/collections';
    const result = await this.makeRequest(endpoint);
    return result.collections || [];
  }

  /**
   * Create a new collection (optionally in a workspace)
   */
  async createCollection(collectionData, workspaceId = null) {
    const endpoint = workspaceId ? `/collections?workspace=${workspaceId}` : '/collections';
    return this.makeRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({ collection: collectionData })
    });
  }

  /**
   * Update an existing collection
   */
  async updateCollection(collectionId, collectionData) {
    return this.makeRequest(`/collections/${collectionId}`, {
      method: 'PUT',
      body: JSON.stringify({ collection: collectionData })
    });
  }

  /**
   * Find collection by name (optionally in a workspace)
   */
  async findCollectionByName(name, workspaceId = null) {
    const collections = await this.getCollections(workspaceId);
    return collections.find(col => col.name === name);
  }
}

async function pushCollectionToPostman(collectionPath, collectionName, displayName, workspaceId = null) {
  console.log(`📤 Pushing collection: ${displayName}`);
  
  if (!fs.existsSync(collectionPath)) {
    console.warn(`⚠️  Collection file not found: ${collectionPath}`);
    return;
  }

  try {
    const collectionData = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
    
    // Generate timestamp for description
    const now = new Date();
    const humanReadableDate = now.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    // Update the collection name and description
    collectionData.info.name = displayName;
    collectionData.info.description = `Auto-generated Postman collection from staging deployment.\n\nGenerated: ${humanReadableDate}\nEnvironment: Staging\nSource: GitHub Actions Workflow\n\nThis collection contains all API endpoints for the ${collectionName.split('-')[0]} gateway.`;
    
    const api = new PostmanAPI(process.env.POSTMAN_API_KEY);
    
    // Check if collection already exists (by unique name)
    const existingCollection = await api.findCollectionByName(collectionName, workspaceId);
    
    if (existingCollection) {
      console.log(`🔄 Updating existing collection: ${displayName} (ID: ${existingCollection.uid})`);
      await api.updateCollection(existingCollection.uid, collectionData);
      console.log(`✅ Updated collection: ${displayName}`);
    } else {
      console.log(`🆕 Creating new collection: ${displayName}`);
      const result = await api.createCollection(collectionData, workspaceId);
      console.log(`✅ Created collection: ${displayName} (ID: ${result.collection.uid})`);
    }
    
  } catch (error) {
    console.error(`❌ Error pushing collection ${displayName}:`, error.message);
    throw error;
  }
}

async function main() {
  console.log('🚀 Starting Postman collection push...');
  
  if (!process.env.POSTMAN_API_KEY) {
    throw new Error('POSTMAN_API_KEY environment variable is required');
  }

  const api = new PostmanAPI(process.env.POSTMAN_API_KEY);
  
  // Get team workspace (look for workspace with "team" in name or use first available)
  let workspaceId = null;
  try {
    const workspaces = await api.getWorkspaces();
    const teamWorkspace = workspaces.find(ws => 
      ws.name.toLowerCase().includes('team') || 
      ws.name.toLowerCase().includes('project x') ||
      ws.type === 'team'
    );
    
    if (teamWorkspace) {
      workspaceId = teamWorkspace.id;
      console.log(`🏢 Using team workspace: ${teamWorkspace.name} (${workspaceId})`);
    } else if (workspaces.length > 0) {
      workspaceId = workspaces[0].id;
      console.log(`🏢 Using first available workspace: ${workspaces[0].name} (${workspaceId})`);
    } else {
      console.log('🏠 Using personal workspace (no team workspace found)');
    }
  } catch (error) {
    console.warn('⚠️  Could not fetch workspaces, using personal workspace:', error.message);
  }

  const collectionsDir = path.resolve(__dirname, '..', 'postman-collections');
  
  if (!fs.existsSync(collectionsDir)) {
    console.warn(`⚠️  Collections directory not found: ${collectionsDir}`);
    return;
  }

  // Generate timestamp for collection naming
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2024-01-15T10-30-45
  const humanReadableDate = now.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }); // Jan 15, 2024, 10:30 AM

  // Read gateway config to get collection names
  const configPath = path.resolve(__dirname, '..', 'gateway', 'config.json');
  let collections = [];
  
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    collections = Object.keys(config.gateways).map(gatewayName => ({
      file: `${gatewayName}-gateway.postman_collection.json`,
      name: `${gatewayName}-staging-${timestamp}`,
      displayName: `Project X - ${config.gateways[gatewayName].name || gatewayName} (Staging - ${humanReadableDate})`,
      baseName: config.gateways[gatewayName].name || gatewayName // For script preservation matching
    }));
  } else {
    // Fallback to default collections
    collections = [
      {
        file: 'app-gateway.postman_collection.json',
        name: 'app-staging-' + timestamp,
        displayName: `Project X - App API Gateway (Staging - ${humanReadableDate})`,
        baseName: 'App API Gateway'
      },
      {
        file: 'dashboard-gateway.postman_collection.json',
        name: 'dashboard-staging-' + timestamp,
        displayName: `Project X - Dashboard API Gateway (Staging - ${humanReadableDate})`,
        baseName: 'Dashboard API Gateway'
      }
    ];
  }

  for (const collection of collections) {
    const collectionPath = path.join(collectionsDir, collection.file);
    await pushCollectionToPostman(collectionPath, collection.name, collection.displayName, workspaceId);
  }
  
  console.log('✅ All collections pushed to Postman successfully!');
}

if (require.main === module) {
  main().catch(error => {
    console.error('⚠️  Failed to push collections to Postman:', error.message);
    console.error('🔄 Continuing workflow without Postman updates...');
    process.exit(0); // Exit with success to not fail the workflow
  });
}

module.exports = { PostmanAPI, pushCollectionToPostman };
