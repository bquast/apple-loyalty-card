// Load JSZip (since it's in root, fetch as asset)
async function loadJSZip(env) {
  const jszipResp = await env.ASSETS.fetch('./jszip.min.js');
  const jszipText = await jszipResp.text();
  const exports = {};
  new Function('module', jszipText)({ exports });
  return exports.exports;
}

// PEM to ArrayBuffer
function pemToArrayBuffer(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, '');
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
}

// SHA1 hash
async function sha1(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return await crypto.subtle.digest('SHA-1', buffer);
}

// Sign data
async function signData(privateKeyPem, data) {
  const privateKeyBuffer = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
    false,
    ['sign']
  );
  return await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
}

// Generate unique serial (simple timestamp + random)
function generateSerial() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const name = body.name || 'Customer';
  
  const serial = generateSerial();
  const userId = serial; // For QR
  const initialBalance = 0.0;
  const authToken = Math.random().toString(36).slice(2); // Per-pass token
  
  // Store in KV
  await env.LOYALTY_KV.put(serial, JSON.stringify({
    name,
    balance: initialBalance,
    lastUpdated: Date.now(),
    authToken,
    devices: [] // For future push
  }));
  
  // Fetch assets
  const logoResp = await env.ASSETS.fetch('https://apply-loyalt-card.pages.dev/logo.png');
  const logoBuffer = await logoResp.arrayBuffer();
  // Add other images similarly if needed
  
  // pass.json
  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: env.PASS_TYPE_ID,
    serialNumber: serial,
    teamIdentifier: env.TEAM_ID,
    webServiceURL: `https://${new URL(request.url).host}/api/`,
    authenticationToken: authToken,
    organizationName: 'The Flying Dutchman',
    description: 'Loyalty Card',
    logoText: 'The Flying Dutchman',
    foregroundColor: 'rgb(0,0,0)',
    backgroundColor: 'rgb(255,182,193)', // Pink like screenshot
    barcode: {
      message: userId, // Or URL like `https://yourdomain.com/scan?id=${userId}`
      format: 'PKBarcodeFormatQR',
      messageEncoding: 'iso-8859-1'
    },
    storeCard: {
      primaryFields: [{
        key: 'balance',
        label: '€ AVAILABLE',
        value: initialBalance,
        currencyCode: 'EUR'
      }],
      // Add secondary/auxiliary if needed, e.g. name
      secondaryFields: [{
        key: 'name',
        label: 'CARD OF',
        value: name
      }],
      backFields: [{
        key: 'links',
        label: 'Useful Links',
        value: 'Tap the button on the back for more.'
      }]
    }
  };
  
  const passJsonString = JSON.stringify(passJson);
  const passJsonBuffer = new TextEncoder().encode(passJsonString);
  
  // Files map (name to ArrayBuffer)
  const files = {
    'pass.json': passJsonBuffer,
    'logo.png': logoBuffer,
    // Add 'icon.png', etc.
  };
  
  // Manifest
  const manifest = {};
  for (const [file, buffer] of Object.entries(files)) {
    const hashBuffer = await sha1(buffer);
    const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    manifest[file] = hashHex;
  }
  const manifestString = JSON.stringify(manifest);
  const manifestBuffer = new TextEncoder().encode(manifestString);
  files['manifest.json'] = manifestBuffer;
  
  // Signature
  const manifestHash = await sha1(manifestBuffer);
  const signatureBuffer = await signData(env.PASS_PRIVATE_KEY, manifestHash);
  files['signature'] = signatureBuffer;
  
  // Zip
  const JSZip = await loadJSZip(env);
  const zip = new JSZip();
  for (const [file, buffer] of Object.entries(files)) {
    zip.file(file, buffer);
  }
  const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
  
  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="loyalty.pkpass"'
    }
  });
}