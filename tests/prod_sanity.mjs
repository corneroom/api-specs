import { argv } from 'node:process';

// Get gateway URL from command-line argument or environment variable
const rawUrl = argv[2] || process.env.GW_URL;

if (!rawUrl) {
  console.error('\n❌ Error: Missing Gateway URL.');
  console.error('   Usage: node tests/prod_sanity.mjs https://<gateway-hostname>/api/v1');
  console.error('   Or:    GW_URL=https://<gateway-hostname>/api/v1 node tests/prod_sanity.mjs\n');
  process.exit(1);
}

// Ensure URL does not end with a trailing slash for consistent joins
const gwUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;

console.log('🏁 Starting Production API Gateway Sanity Verification...');
console.log(`🌐 Target Gateway Base URL: ${gwUrl}\n`);

const sanityChecks = [
  {
    name: 'User Service Routing (/users/heartbeat)',
    url: `${gwUrl}/users/heartbeat`,
    method: 'GET',
    expectedStatus: 200,
  },
  {
    name: 'Listing Service Routing (/listings)',
    url: `${gwUrl}/listings?limit=1`,
    method: 'GET',
    expectedStatus: 200,
  }
];

let failed = false;

for (const check of sanityChecks) {
  console.log(`🧪 Testing: ${check.name}...`);
  try {
    const startTime = Date.now();
    const res = await fetch(check.url, { method: check.method });
    const duration = Date.now() - startTime;
    
    if (res.status === check.expectedStatus) {
      console.log(`  ✅ Passed: Status ${res.status} (${duration}ms)`);
    } else {
      console.error(`  ❌ Failed: Expected Status ${check.expectedStatus}, received ${res.status} (${duration}ms)`);
      failed = true;
    }
  } catch (error) {
    console.error(`  ❌ Failed: Connection error - ${error.message}`);
    failed = true;
  }
  console.log('');
}

if (failed) {
  console.error('❌ Production Gateway Sanity Verification FAILED! Some microservices are unreachable.');
  process.exit(1);
} else {
  console.log('🎉 Production Gateway Sanity Verification PASSED! Gateways are actively routing traffic successfully.');
  process.exit(0);
}
