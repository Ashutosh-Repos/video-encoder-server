import { NextResponse } from "next/server";

export function middleware(req: Request) {
  const { pathname } = new URL(req.url);
  const res = NextResponse.next();

  const validRoutes = [
    "/api/healthcheck",
    "/api/create-stream",
    "/api/stream",
    "/api/up",
  ];

  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: res.headers });
  }

  if (pathname.startsWith("/api") && !validRoutes.includes(pathname)) {
    return NextResponse.json({}, { status: 404 });
  }

  return res;
}

export const config = {
  matcher: "/api/:path*",
};
