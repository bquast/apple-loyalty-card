// Reuse helpers from generate.js (copy sha1, signData, pemToArrayBuffer, loadJSZip)

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const passType = params.passType;
  const serial = params.serial;
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('ApplePass ')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const token = authHeader.slice(10);
  
  const dataJson = await env.LOYALTY_KV.get(serial);
  if (!dataJson) return new Response('Not Found', { status: 404 });
  const data = JSON.parse(dataJson);
  if (data.authToken !== token) return new Response('Unauthorized', { status: 401 });
  
  // If-Modified-Since check (optional for caching)
  const ifModifiedSince = request.headers.get('If-Modified-Since');
  if (ifModifiedSince && new Date(ifModifiedSince).getTime() >= data.lastUpdated) {
    return new Response(null, { status: 304 });
  }
  
  // Generate updated pass.json with current balance
  // (Copy passJson creation from generate.js, update value: data.balance)
  // Then files, manifest, signature, zip as above
  
  // Return with Last-Modified header
  return new Response(zipBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Last-Modified': new Date(data.lastUpdated).toUTCString()
    }
  });
}