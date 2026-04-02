export async function GET() {
  const key = process.env.GOOGLE_MAPS_API_KEY ?? "";
  return Response.json({
    keySet: !!key,
    keyLen: key.length,
    keyStart: key.slice(0, 8),
  });
}
