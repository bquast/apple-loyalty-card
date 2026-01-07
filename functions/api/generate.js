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

// Generate unique serial
function generateSerial() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const name = body.name || 'Customer';
  
  const serial = generateSerial();
  const userId = serial;
  const initialBalance = 0.0;
  const authToken = Math.random().toString(36).slice(2);
  
  // Store in KV
  await env.LOYALTY_KV.put(serial, JSON.stringify({
    name,
    balance: initialBalance,
    lastUpdated: Date.now(),
    authToken,
    devices: []
  }));
  
  // Fetch assets (use dummy host for URL)
  const logoResp = await env.ASSETS.fetch('http://placeholder/logo.png');
  if (!logoResp.ok) throw new Error('Logo not found');
  const logoBuffer = await logoResp.arrayBuffer();
  
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
      message: userId, // Or `https://apple-loyalty-card.pages.dev/scan?id=${userId}`
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
  
  // Files map (name to Uint8Array – use Uint8Array for easier concat)
  const files = {
    'pass.json': new Uint8Array(passJsonBuffer),
    'logo.png': new Uint8Array(logoBuffer),
    // Add 'icon.png' etc. if needed
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
  files['manifest.json'] = new Uint8Array(manifestBuffer);
  
  // Signature
  const manifestHash = await sha1(manifestBuffer);
  const signatureBuffer = await signData(env.PASS_PRIVATE_KEY, manifestHash);
  files['signature'] = new Uint8Array(signatureBuffer);
  
  // Generate ZIP buffer (stored mode, no compression)
  const zipBuffer = createZip(files);
  
  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="loyalty.pkpass"'
    }
  });
}

// Manual ZIP creator for stored files (compression 0, vanilla JS)
function createZip(files) {
  const centralRecords = [];
  const endCentral = { offset: 0, size: 0 };
  let dataOffset = 0;
  const encoder = new TextEncoder();

  // Local file headers and data
  const localHeadersAndData = [];
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);

    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 20, true); // Version needed to extract (2.0)
    view.setUint16(6, 0, true); // General purpose bit flag
    view.setUint16(8, 0, true); // Compression method (0 = stored)
    view.setUint16(10, 0, true); // Last mod file time
    view.setUint16(12, 0, true); // Last mod file date
    view.setUint32(14, crc32(data), true); // CRC-32
    view.setUint32(18, data.length, true); // Compressed size
    view.setUint32(22, data.length, true); // Uncompressed size
    view.setUint16(26, nameBytes.length, true); // File name length
    view.setUint16(28, 0, true); // Extra field length

    localHeader.set(nameBytes, 30); // File name

    localHeadersAndData.push(localHeader);
    localHeadersAndData.push(data);

    // Central directory record for this file
    const centralRecord = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(centralRecord.buffer);

    cView.setUint32(0, 0x02014b50, true); // Central file header signature
    view.setUint16(4, 20, true); // Version made by (2.0)
    cView.setUint16(6, 20, true); // Version needed to extract
    cView.setUint16(8, 0, true); // General purpose bit flag
    cView.setUint16(10, 0, true); // Compression method
    cView.setUint16(12, 0, true); // Last mod file time
    cView.setUint16(14, 0, true); // Last mod file date
    cView.setUint32(16, crc32(data), true); // CRC-32
    cView.setUint32(20, data.length, true); // Compressed size
    cView.setUint32(24, data.length, true); // Uncompressed size
    cView.setUint16(28, nameBytes.length, true); // File name length
    cView.setUint16(30, 0, true); // Extra field length
    cView.setUint16(32, 0, true); // File comment length
    cView.setUint16(34, 0, true); // Disk number start
    cView.setUint16(36, 0, true); // Internal file attributes
    cView.setUint32(38, 0, true); // External file attributes
    cView.setUint32(42, dataOffset, true); // Relative offset of local header

    centralRecord.set(nameBytes, 46); // File name

    centralRecords.push(centralRecord);

    dataOffset += localHeader.length + data.length;
  }

  // End of central directory
  const centralSize = centralRecords.reduce((sum, rec) => sum + rec.length, 0);
  const endHeader = new Uint8Array(22);
  const eView = new DataView(endHeader.buffer);

  eView.setUint32(0, 0x06054b50, true); // End of central dir signature
  eView.setUint16(4, 0, true); // Number of this disk
  eView.setUint16(6, 0, true); // Number of the disk with the start of the central directory
  eView.setUint16(8, centralRecords.length, true); // Total number of entries on this disk
  eView.setUint16(10, centralRecords.length, true); // Total number of entries
  eView.setUint32(12, centralSize, true); // Size of the central directory
  eView.setUint32(16, dataOffset, true); // Offset of start of central directory
  eView.setUint16(20, 0, true); // .ZIP file comment length

  // Concat all parts
  let totalSize = dataOffset + centralSize + endHeader.length;
  const zip = new Uint8Array(totalSize);
  let offset = 0;

  for (const part of localHeadersAndData) {
    zip.set(part, offset);
    offset += part.length;
  }

  for (const rec of centralRecords) {
    zip.set(rec, offset);
    offset += rec.length;
  }

  zip.set(endHeader, offset);

  return zip;
}

// Simple CRC32 function (vanilla JS, no lib)
function crc32(data) {
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

// Precomputed CRC table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}