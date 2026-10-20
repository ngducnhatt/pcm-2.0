import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const started = Date.now();
  try {
    const row = await getDb()
      .prepare<{ total: number | string; latest: string | null }>(
        "SELECT COUNT(*) AS total, MAX(version) AS latest FROM schema_migrations"
      )
      .bind()
      .first();
    if (!row) throw new Error("Database trả về kết quả rỗng.");
    if (Number(row.total) < 1) {
      throw new Error("Database chưa được migrate.");
    }

    return Response.json(
      {
        status: "ok",
        service: "pcm-opsflow",
        database: "up",
        schemaVersion: row.latest,
        migrations: Number(row.total),
        dbLatencyMs: Date.now() - started,
        time: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime())
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    logger.error("Health check thất bại", {
      message: error instanceof Error ? error.message : String(error)
    });
    return Response.json(
      {
        status: "error",
        service: "pcm-opsflow",
        database: "down",
        time: new Date().toISOString()
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
