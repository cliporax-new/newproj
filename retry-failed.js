'use strict';

// Standalone runner to retry failed comments & SMM orders on RDP
const http = require('node:http');

console.log('\n============================================================');
console.log('   RETRYING ALL FAILED COMMENTS & SMM ORDERS (Last 3 Hours)...');
console.log('============================================================\n');

const req = http.request(
  {
    hostname: '127.0.0.1',
    port: 4610,
    path: '/api/jobs/retry-failed',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.ok) {
          console.log('✅ SUCCESS!');
          console.log(`   ${json.message}`);
          console.log(`   Retried Failed Comments: ${json.retriedCount || 0}`);
          console.log(`   Retried SMM Orders     : ${json.smmRetried || 0}`);
          if (json.jobId) console.log(`   New Recovery Job ID    : ${json.jobId}`);
          console.log('\nAll failed comments are now running with active accounts & RapidProxy!\n');
        } else {
          console.log('⚠️ Notice:', json.error || json.message || 'No failed comments found.');
        }
      } catch {
        console.log('Server response:', data);
      }
    });
  }
);

req.on('error', (err) => {
  console.error('❌ Could not connect to server:', err.message);
  console.log('Please ensure START.bat is running on your RDP first!');
});

req.write(JSON.stringify({ hours: 3 }));
req.end();
