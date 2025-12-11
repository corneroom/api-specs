const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const inputDir = path.join(__dirname, '../gateway');
const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.yaml'));

function validateSwaggerXGoogleBackendAddress(swaggerPath) {
  const content = fs.readFileSync(swaggerPath, 'utf8');
  let doc;
  try {
    doc = yaml.load(content);
  } catch (e) {
    console.error(`\x1b[41m\x1b[37m[ERROR]\x1b[0m YAML parse error in ${swaggerPath}: ${e.message}`);
    throw e;
  }
  let found = false;
  function check(obj, pathStr) {
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        if (key === 'x-google-backend') {
          found = true;
          if (!obj[key] || typeof obj[key] !== 'object' || !obj[key].address) {
            console.error(`\n\x1b[41m\x1b[37m[FAIL]\x1b[0m \u274C Missing 'address' in x-google-backend at ${pathStr} in ${swaggerPath}`);
            console.error(`\x1b[31mPlease ensure every operation has a valid x-google-backend.address.\x1b[0m`);
            throw new Error(`Missing 'address' in x-google-backend at ${pathStr} in ${swaggerPath}`);
          }
        }
        check(obj[key], pathStr ? `${pathStr}.${key}` : key);
      }
    }
  }
  check(doc, '');
  if (!found) {
    console.error(`\n\x1b[41m\x1b[37m[FAIL]\x1b[0m \u274C No x-google-backend found in ${swaggerPath}`);
    console.error(`\x1b[31mYour gateway spec must have x-google-backend for every operation.\x1b[0m`);
    throw new Error(`No x-google-backend found in ${swaggerPath}`);
  }
}

files.forEach(file => {
  const filePath = path.join(inputDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes('openapi: 3.0')) {
    const base = path.basename(file, '.yaml');
    const outPath = path.join(inputDir, `${base}-swagger.yaml`);
    try {
      // Convert OpenAPI 3.0 to Swagger 2.0 YAML
      execSync(`npx api-spec-converter -f openapi_3 -t swagger_2 -s yaml "${filePath}" > "${outPath}"`, { stdio: 'inherit' });
      // Validate the output
      execSync(`npx swagger-cli validate "${outPath}"`, { stdio: 'inherit' });
      // Custom validation: Swagger must have x-google-backend with address
      validateSwaggerXGoogleBackendAddress(outPath);
      console.log(`Converted and validated: ${file} -> ${base}-swagger.yaml`);
    } catch (err) {
      console.error(`Error processing ${file}:`, err.message);
      process.exit(1);
    }
  } else {
    console.log(`Skipping ${file} (not OpenAPI 3.0)`);
  }
});
