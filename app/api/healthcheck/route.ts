export async function GET() {
  return new Response(JSON.stringify({ message: "Hello from Next.js API!" }), {
    headers: { "Content-Type": "application/json" },
  });
}
