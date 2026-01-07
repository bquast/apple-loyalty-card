import * as forge from '../../forge.js';

// PEM to ArrayBuffer not needed now – Forge handles PEM directly

// SHA1 hash (use Forge's)
async function sha1(data) {
  const md = forge.md.sha1.create();
  md.update(data);
  return md.digest().bytes();
}

// Generate PKCS7 detached signature
async function generateSignature(manifestBuffer, privateKeyPem, passCertPem, wwdrCertPem) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = new forge.util.ByteStringBuffer(); // Detached, so empty content

  // Load certs and key
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const passCert = forge.pki.certificateFromPem(passCertPem);
  const wwdrCert = forge.pki.certificateFromPem(wwdrCertPem);

  // Add signer
  p7.addSigner({
    key: privateKey,
    certificate: passCert,
    digestAlgorithm: forge.pki.oids.sha1,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data
      },
      {
        type: forge.pki.oids.messageDigest // Auto-added during sign
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date()
      }
    ]
  });

  // Add chain certs (WWDR as additional cert)
  p7.certificates = [passCert, wwdrCert];

  p7.sign({detached: true});

  // Get DER bytes
  const derBytes = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.binary.raw.toBytes(derBytes); // String to Uint8Array later
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
  
  // Fetch assets
  const logoResp = await env.ASSETS.fetch('http://placeholder/logo.png');
  if (!logoResp.ok) throw new Error('Logo not found');
  const logoBuffer = await logoResp.arrayBuffer();
  
  // pass.json (same)
  // ... (keep the passJson object)

  const passJsonString = JSON.stringify(passJson);
  const passJsonBuffer = new TextEncoder().encode(passJsonString);
  
  // Files (Uint8Array)
  const files = {
    'pass.json': new Uint8Array(passJsonBuffer),
    'logo.png': new Uint8Array(logoBuffer),
  };
  
  // Manifest
  const manifest = {};
  for (const [file, buffer] of Object.entries(files)) {
    const hashHex = forge.util.bytesToHex(await sha1(forge.util.binary.raw.fromBytes(buffer)));
    manifest[file] = hashHex;
  }
  const manifestString = JSON.stringify(manifest);
  const manifestBuffer = new TextEncoder().encode(manifestString);
  files['manifest.json'] = new Uint8Array(manifestBuffer);
  
  // Signature (PKCS7)
  const signatureBytes = await generateSignature(manifestBuffer, env.PASS_PRIVATE_KEY, env.PASS_CERT_PEM, env.WWDR_PEM);
  files['signature'] = new Uint8Array(forge.util.createBuffer(signatureBytes).bytes().split('').map(c => c.charCodeAt(0)));
  
  // ZIP (keep your manual createZip)
  const zipBuffer = createZip(files);
  
  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="loyalty.pkpass"'
    }
  });
}

// keep createZip and crc32 functions...