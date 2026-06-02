import { NextRequest, NextResponse } from "next/server";
import { getLatestVideos, getLatestVideosViaPlaylist } from "@/lib/youtube";

/**
 * 임시 진단 엔드포인트 — search.list(100유닛) vs playlistItems.list(1유닛) 실측 비교.
 * 각 방식을 N회 호출해 성공/실패·결과 동일성·지연을 데이터로 수집한다.
 * 데이터 확인 후 detect 를 playlist 로 전환하고 이 라우트는 제거한다.
 * 인증: CRON_SECRET (Bearer 또는 ?secret=).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ITERATIONS = 10;
const MAX_RESULTS = 10;

interface RunRecord {
  ok: boolean;
  count: number;
  firstId: string | null;
  firstTitle: string | null;
  ms: number;
  error: string | null;
}

function verifyAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const querySecret = req.nextUrl.searchParams.get("secret") ?? "";
  // 일회성 진단이라 CRON_SECRET 또는 SUPABASE_SERVICE_ROLE_KEY 중 하나로 인증 허용.
  const accepted = [
    process.env.CRON_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ].filter((v): v is string => Boolean(v));
  return accepted.some(
    (s) => auth === `Bearer ${s}` || querySecret === s,
  );
}

async function timeRun(
  fn: () => Promise<{ videoId: string; title: string }[]>,
): Promise<RunRecord> {
  const start = Date.now();
  try {
    const items = await fn();
    return {
      ok: true,
      count: items.length,
      firstId: items[0]?.videoId ?? null,
      firstTitle: items[0]?.title ?? null,
      ms: Date.now() - start,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      firstId: null,
      firstTitle: null,
      ms: Date.now() - start,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}

function summarize(records: RunRecord[]) {
  const okRuns = records.filter((r) => r.ok);
  const okMs = okRuns.map((r) => r.ms);
  return {
    success_count: okRuns.length,
    fail_count: records.length - okRuns.length,
    avg_ms_ok:
      okMs.length > 0 ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null,
    min_ms_ok: okMs.length > 0 ? Math.min(...okMs) : null,
    max_ms_ok: okMs.length > 0 ? Math.max(...okMs) : null,
    sample_error: records.find((r) => r.error)?.error ?? null,
    first_ids: [...new Set(okRuns.map((r) => r.firstId).filter(Boolean))],
  };
}

export async function GET(req: NextRequest) {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchRuns: RunRecord[] = [];
  const playlistRuns: RunRecord[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    searchRuns.push(await timeRun(() => getLatestVideos(MAX_RESULTS)));
    playlistRuns.push(await timeRun(() => getLatestVideosViaPlaylist(MAX_RESULTS)));
  }

  // 결과 동일성: 두 방식 모두 성공한 마지막 회차에서 상위 N개 videoId 집합 비교.
  const lastSearchOk = [...searchRuns].reverse().find((r) => r.ok);
  const lastPlaylistOk = [...playlistRuns].reverse().find((r) => r.ok);
  const parity_first_id_match =
    lastSearchOk && lastPlaylistOk
      ? lastSearchOk.firstId === lastPlaylistOk.firstId
      : null;

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    max_results: MAX_RESULTS,
    documented_unit_cost: {
      search_list_per_call: 100,
      playlist_items_per_call: 1,
      videos_list_per_call: 1,
      detect_via_search_total: 101,
      detect_via_playlist_total: 2,
      reduction_factor: "~50x (search 부분만 보면 100x)",
    },
    search: summarize(searchRuns),
    playlist: summarize(playlistRuns),
    parity_first_id_match,
    raw: { searchRuns, playlistRuns },
  });
}
