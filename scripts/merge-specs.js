#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

// Configuration
const CONFIG = {
  servicesDir: path.resolve(__dirname, '../services'),
  gatewayDir: path.resolve(__dirname, '../gateway'),
  generateDir: path.resolve(__dirname, '../.generate'),
};

let mergedSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Combined API Specification',
    version: '1.0.0',
    description: 'Merged API specs for services and gateways.'
  },
  paths: {},
  components: {
    schemas: {},
    securitySchemes: {}
  }
};

function deepMerge(target, source) {
  for (const key in source) {
    if (source[key] instanceof Object && key in target) {
      Object.assign(source[key], deepMerge(target[key], source[key]));
    }
  }
  return Object.assign(target || {}, source);
}

function convertSpec(file, type) {
  const originalFileName = path.basename(file, path.extname(file));
  const convertedFile = path.join(CONFIG.generateDir, `${originalFileName}-converted-${type}.yaml`);
  try {
    const quotedFile = `"${file}"`; // Quote file path to handle spaces
    const specContent = fs.readFileSync(file, 'utf8');
    const spec = yaml.load(specContent);

    if (spec.swagger === '2.0') {
      console.log(`Converting Swagger 2.0 spec to OpenAPI 3.0: ${file}`);
      execSync(`npx swagger2openapi -o "${convertedFile}" ${quotedFile}`);
    } else if (spec.openapi && spec.openapi.startsWith('3.0.')) {
      console.log(`Spec is already OpenAPI 3.0.x: ${file}`);
      return file; // Skip conversion and return original file
    } else {
      throw new Error(`Unsupported spec format in file: ${file}`);
    }

    // Ensure output is in YAML format
    const convertedContent = fs.readFileSync(convertedFile, 'utf8');
    const convertedSpec = yaml.load(convertedContent);
    fs.writeFileSync(convertedFile, yaml.dump(convertedSpec));
  } catch (error) {
    console.error(`Failed to convert spec: ${file}`, error.message);
    process.exit(1);
  }

  return convertedFile;
}

function mergeSpecs(files) {
  files.forEach(file => {
    const spec = yaml.load(fs.readFileSync(file, 'utf8'));

    // Merge paths
    mergedSpec.paths = deepMerge(mergedSpec.paths, spec.paths);

    // Merge components
    if (spec.components) {
      mergedSpec.components.schemas = deepMerge(mergedSpec.components.schemas, spec.components.schemas);
      mergedSpec.components.securitySchemes = deepMerge(mergedSpec.components.securitySchemes, spec.components.securitySchemes);
    }
  });
}

function generateGatewaySpecs(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  Object.entries(config.gateways).forEach(([gatewayName, gatewayConfig]) => {
    if (!gatewayConfig.hosts) {
      throw new Error(`Missing 'hosts' property for gateway: ${gatewayName}`);
    }

    // Use hosts array for multiple environments
    let servers = [];
    if (Array.isArray(gatewayConfig.hosts)) {
      servers = gatewayConfig.hosts.map(host => ({ url: host.url, description: host.description || undefined }));
    } else {
      throw new Error(`'hosts' property must be an array for gateway: ${gatewayName}`);
    }
    const gatewaySpec = {
      openapi: '3.0.0',
      info: {
        title: gatewayConfig.name,
        description: gatewayConfig.description,
        version: gatewayConfig.version,
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT',
        },
      },
      servers: servers,
      paths: {},
      components: {
        schemas: {},
        securitySchemes: {},
      },
    };

    // Collect missing service specs
    let missingSpecs = [];
    gatewayConfig.services.forEach(serviceName => {
      const serviceFile = path.join(CONFIG.servicesDir, `${serviceName}.yaml`);
      if (fs.existsSync(serviceFile)) {
        const convertedFile = convertSpec(serviceFile, gatewayName);
        const serviceSpec = yaml.load(fs.readFileSync(convertedFile, 'utf8'));

        // Merge paths
        gatewaySpec.paths = deepMerge(gatewaySpec.paths, serviceSpec.paths);

        // Merge components
        if (serviceSpec.components) {
          gatewaySpec.components.schemas = deepMerge(gatewaySpec.components.schemas, serviceSpec.components.schemas);
          gatewaySpec.components.securitySchemes = deepMerge(gatewaySpec.components.securitySchemes, serviceSpec.components.securitySchemes);
          gatewaySpec.components.responses = deepMerge(gatewaySpec.components.responses || {}, serviceSpec.components.responses || {});
        }
      } else {
        missingSpecs.push(serviceName);
      }
    });

    if (missingSpecs.length > 0) {
      console.error(`\u274C  ERROR: Missing service specs for gateway '${gatewayName}': ${missingSpecs.join(', ')}`);
      console.error('      ➡️  Fix the config.json and try again later!!');
      process.exit(1);
    }

    // If a top-level x-google-backend exists, apply it to all operations that don't have it
    const topLevelBackend = gatewayConfig.services
      .map(serviceName => {
        const serviceFile = path.join(CONFIG.servicesDir, `${serviceName}.yaml`);
        if (fs.existsSync(serviceFile)) {
          const spec = yaml.load(fs.readFileSync(serviceFile, 'utf8'));
          return spec['x-google-backend'];
        }
        return undefined;
      })
      .find(Boolean);

    if (topLevelBackend) {
      for (const pathKey of Object.keys(gatewaySpec.paths)) {
        const pathItem = gatewaySpec.paths[pathKey];
        for (const method of Object.keys(pathItem)) {
          const op = pathItem[method];
          if (!op['x-google-backend']) {
            op['x-google-backend'] = topLevelBackend;
          }
        }
      }
    }

    // Save gateway specs directly in 'gateway' directory
    fs.writeFileSync(path.join(CONFIG.gatewayDir, `${gatewayName}.yaml`), yaml.dump(gatewaySpec));
    console.log(`Generated gateway spec: ${gatewayName}.yaml`);
  });
}

async function main() {
  try {
    // Ensure directories exist
    if (!fs.existsSync(CONFIG.gatewayDir)) {
      fs.mkdirSync(CONFIG.gatewayDir);
    }
    if (!fs.existsSync(CONFIG.generateDir)) {
      fs.mkdirSync(CONFIG.generateDir);
    }

    // Collect all service specs
    const serviceSpecs = fs.readdirSync(CONFIG.servicesDir)
      .filter(file => file.endsWith('.yaml'))
      .map(file => path.join(CONFIG.servicesDir, file));

    console.log(`Found ${serviceSpecs.length} service specs in services directory`);

    // Generate gateway specs
    const configPath = path.join(CONFIG.gatewayDir, 'config.json');
    if (fs.existsSync(configPath)) {
      generateGatewaySpecs(configPath);
    } else {
      console.error('Gateway config.json not found');
      process.exit(1);
    }

    console.log('Gateway specs generated successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the main function
main();
