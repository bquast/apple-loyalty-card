export async function onRequestPost(context) {
  const { params, request, env } = context;
  const serial = params.serial;
  const dataJson = await env.LOYALTY_KV.get(serial);
  if (!dataJson) return new Response('Not Found', { status: 404 });
  const data = JSON.parse(dataJson);
  
  // Auth check as above...
  
  const body = await request.json();
  const pushToken = body.pushToken;
  data.devices.push({ device: params.device, pushToken });
  data.lastUpdated = Date.now();
  await env.LOYALTY_KV.put(serial, JSON.stringify(data));
  
  return new Response(null, { status: 204 });
}