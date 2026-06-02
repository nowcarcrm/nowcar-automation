import { createAdminClient } from "@/lib/storage";
import { recencyCutoffIso } from "@/lib/video-recency";
import { sendPipelineHealthAlert } from "@/lib/mailer";

/**
 * ============================================================
 * lib/pipeline-health.ts
 * ------------------------------------------------------------
 * 파이프라인 "조용한 고장" 감지 + 운영자 다이제스트 알림.
 *
 * 배경(2026-06-02): 개별 사고(쿠키 봇차단·카페 999·Meta 토큰)는 각각 알림이
 * 있지만, "발행 파이프라인 전체가 멈췄는데 아무도 모르는" 무성한 실패를 잡는
 * 상위 감시가 없었다. 운영자가 SNS 피드를 눈으로 보고 나서야 알아채는 구조.
 *
 * 이 모듈은 매일 도는 Vercel cron(/api/cron/download)에서 1회 호출된다.
 * 사무실 PC 가 꺼져 있어도 cron 은 돌므로 신뢰할 수 있는 감시 앵커다.
 *
 * 설계 원칙: 오탐(false alarm) 최소화.
 *   "오늘 발행이 0건"처럼 정상적으로 한가할 수 있는 신호는 쓰지 않는다.
 *   대신 명백히 고장난 상태만 본다:
 *     1) 2h+ 멈춘 pending 발행 (발행 시작했는데 끝나지 않음)
 *     2) 36h+ 미다운로드 백로그 (로컬 워커도 Drive 도 못 가져옴)
 *     3) 카페 제외 발행 실패 급증 (Meta/스레드 인증 등 광범위 장애)
 *     4) Meta 토큰 만료 임박(<7일)
 * 하나라도 걸리면 12h cooldown 으로 다이제스트 메일 1통.
 * ============================================================
 */

const ALERT_TYPE_HEALTH = "pipeline_health";
const ALERT_COOLDOWN_HOURS = 12;

/** pending 이 이 시간보다 오래 멈춰 있으면 발행이 중간에 깨진 것으로 본다. */
const STUCK_PENDING_HOURS = 2;
/** 다운로드 대기가 이 시간을 넘으면 로컬 워커·Drive 둘 다 실패한 것으로 본다. */
const UNDOWNLOADED_STALE_HOURS = 36;
/** 최근 24h non-cafe 발행 실패가 이 수 이상이면 광범위 장애로 본다. */
const FAILURE_SURGE_THRESHOLD = 5;
/** Meta 토큰 만료가 이 일수 이내면 사전 경고. */
const TOKEN_EXPIRY_WARN_DAYS = 7;

export interface HealthAnomaly {
  key: string;
  title: string;
  detail: string;
}

export interface HealthCheckResult {
  anomalies: HealthAnomaly[];
  context: string[];
  alertSent: boolean;
  alertReason: string;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * 헬스 체크 실행 + 이상 시 알림. 호출자(cron) 흐름을 깨지 않도록 내부에서 모든
 * 예외를 흡수한다. 반환값은 로깅/디버깅용.
 */
export async function runPipelineHealthCheck(): Promise<HealthCheckResult> {
  const anomalies: HealthAnomaly[] = [];
  const context: string[] = [];

  try {
    const supabase = createAdminClient();

    // --- 1) 멈춘 pending 발행 ---
    try {
      const { data, error } = await supabase
        .from("social_publishes")
        .select("video_id, platform, created_at")
        .eq("status", "pending")
        .is("deleted_at", null)
        .lt("created_at", hoursAgoIso(STUCK_PENDING_HOURS))
        .order("created_at", { ascending: true })
        .limit(20);
      if (!error && data && data.length > 0) {
        const sample = data
          .slice(0, 5)
          .map((r) => `${r.platform}:${r.video_id}`)
          .join(", ");
        anomalies.push({
          key: "stuck_pending",
          title: `멈춘 pending 발행 ${data.length}건 (${STUCK_PENDING_HOURS}h+)`,
          detail: `발행을 시작했지만 success/failed 로 마감되지 않은 행. 예: ${sample}`,
        });
      }
    } catch (e) {
      console.warn(`[health] stuck pending 체크 실패: ${String(e)}`);
    }

    // --- 2) 미다운로드 백로그 (recency 윈도우 내 영상만) ---
    try {
      const { data, error } = await supabase
        .from("youtube_videos")
        .select("video_id, title, created_at")
        .is("storage_path", null)
        .gte("published_at", recencyCutoffIso())
        .lt("created_at", hoursAgoIso(UNDOWNLOADED_STALE_HOURS))
        .order("created_at", { ascending: true })
        .limit(20);
      if (!error && data && data.length > 0) {
        const oldest = data[0];
        anomalies.push({
          key: "undownloaded_backlog",
          title: `미다운로드 백로그 ${data.length}건 (${UNDOWNLOADED_STALE_HOURS}h+)`,
          detail: `로컬 워커·Drive 둘 다 못 가져온 영상. 가장 오래된: ${oldest?.video_id} (${oldest?.created_at}). 사무실 PC 가동 또는 Drive 사본 업로드 필요.`,
        });
      }
    } catch (e) {
      console.warn(`[health] 미다운로드 백로그 체크 실패: ${String(e)}`);
    }

    // --- 3) non-cafe 발행 실패 급증 (카페는 알려진 999 차단이라 제외) ---
    try {
      const { data, error } = await supabase
        .from("social_publishes")
        .select("platform, error_message")
        .eq("status", "failed")
        .neq("platform", "naver_cafe")
        .is("deleted_at", null)
        .gte("updated_at", hoursAgoIso(24))
        .limit(100);
      if (!error && data && data.length >= FAILURE_SURGE_THRESHOLD) {
        const byPlatform = new Map<string, number>();
        for (const r of data) {
          byPlatform.set(r.platform, (byPlatform.get(r.platform) ?? 0) + 1);
        }
        const breakdown = [...byPlatform.entries()]
          .map(([p, c]) => `${p} ${c}건`)
          .join(", ");
        const sampleErr = data.find((r) => r.error_message)?.error_message ?? "-";
        anomalies.push({
          key: "failure_surge",
          title: `발행 실패 급증 (최근 24h ${data.length}건, 카페 제외)`,
          detail: `채널별: ${breakdown}. 샘플 에러: ${String(sampleErr).slice(0, 200)}`,
        });
      }
    } catch (e) {
      console.warn(`[health] 실패 급증 체크 실패: ${String(e)}`);
    }

    // --- 4) Meta 토큰 만료 임박 ---
    try {
      const { data, error } = await supabase
        .from("system_tokens")
        .select("token_type, expires_at")
        .not("expires_at", "is", null);
      if (!error && data) {
        for (const t of data) {
          const expMs = t.expires_at ? Date.parse(t.expires_at) : NaN;
          if (!Number.isFinite(expMs)) continue;
          const daysLeft = Math.floor((expMs - Date.now()) / (24 * 60 * 60 * 1000));
          if (daysLeft <= TOKEN_EXPIRY_WARN_DAYS) {
            anomalies.push({
              key: `token_expiry_${t.token_type}`,
              title: `토큰 만료 임박: ${t.token_type} (${daysLeft}일 남음)`,
              detail: `expires_at=${t.expires_at}. 자동 갱신이 안 되면 해당 채널 발행이 중단됨.`,
            });
          } else {
            context.push(`토큰 ${t.token_type}: ${daysLeft}일 남음`);
          }
        }
      }
    } catch (e) {
      console.warn(`[health] 토큰 만료 체크 실패: ${String(e)}`);
    }

    // --- 컨텍스트: 채널별 마지막 발행 성공 시각 ---
    try {
      for (const platform of ["instagram", "facebook", "threads", "naver_cafe"]) {
        const { data } = await supabase
          .from("social_publishes")
          .select("updated_at")
          .eq("platform", platform)
          .eq("status", "success")
          .order("updated_at", { ascending: false })
          .limit(1);
        const last = data?.[0]?.updated_at;
        context.push(`마지막 ${platform} 성공: ${last ?? "기록 없음"}`);
      }
    } catch (e) {
      console.warn(`[health] 마지막 성공 시각 조회 실패: ${String(e)}`);
    }

    if (anomalies.length === 0) {
      console.log("[health] ✅ 이상 없음");
      return { anomalies, context, alertSent: false, alertReason: "no anomaly" };
    }

    console.warn(
      `[health] ⚠️ 이상 ${anomalies.length}건: ${anomalies.map((a) => a.key).join(", ")}`,
    );

    // --- cooldown 체크 후 알림 ---
    const cutoff = hoursAgoIso(ALERT_COOLDOWN_HOURS);
    const { data: existing } = await supabase
      .from("system_alerts")
      .select("alert_type, last_sent_at")
      .eq("alert_type", ALERT_TYPE_HEALTH)
      .maybeSingle();

    if (existing && existing.last_sent_at >= cutoff) {
      return {
        anomalies,
        context,
        alertSent: false,
        alertReason: `cooldown(last_sent_at=${existing.last_sent_at})`,
      };
    }

    await sendPipelineHealthAlert({ anomalies, context });

    const nowIso = new Date().toISOString();
    await supabase.from("system_alerts").upsert(
      {
        alert_type: ALERT_TYPE_HEALTH,
        last_sent_at: nowIso,
        last_message: anomalies.map((a) => a.title).join(" | ").slice(0, 500),
        metadata: { anomaly_keys: anomalies.map((a) => a.key) },
      },
      { onConflict: "alert_type" },
    );

    return { anomalies, context, alertSent: true, alertReason: "alert sent" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[health] 체크 전체 실패(무시): ${msg}`);
    return {
      anomalies,
      context,
      alertSent: false,
      alertReason: `error: ${msg}`,
    };
  }
}
