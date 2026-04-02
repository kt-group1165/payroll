export async function GET() {
  const key1 = process.env.GOOGLE_MAPS_API_KEY ?? "";
  const key2 = process.env.DISTANCE_API_KEY ?? "";
  return Response.json({
    GOOGLE_MAPS_API_KEY: { set: !!key1, len: key1.length, start: key1.slice(0, 8) },
    DISTANCE_API_KEY: { set: !!key2, len: key2.length, start: key2.slice(0, 8) },
  });
}
