import { GET as runContentEmail } from "@/app/api/content/email/route";
import { supabase } from "@/lib/supabase";

export interface EmailResult {
  ok: boolean;
  emails_sent_count: number;
  emails_failed_count: number;
  errors: string[];
  has_pending_email: boolean;
}

export async function runEmailStep(): Promise<EmailResult> {
  const { count, error } = await supabase
    .from("generated_contents")
    .select("*", { count: "exact", head: true })
    .eq("email_sent", false);

  if (error) {
    throw new Error(`이메일 대기 건수 조회 실패: ${error.message}`);
  }

  if ((count ?? 0) === 0) {
    return {
      ok: true,
      emails_sent_count: 0,
      emails_failed_count: 0,
      errors: [],
      has_pending_email: false,
    };
  }

  const response = await runContentEmail();
  const data = (await response.json()) as {
    success?: boolean;
    emails_sent_count?: number;
    emails_failed_count?: number;
    errors?: string[];
  };

  return {
    ok: Boolean(data.success ?? true),
    emails_sent_count: data.emails_sent_count ?? 0,
    emails_failed_count: data.emails_failed_count ?? 0,
    errors: data.errors ?? [],
    has_pending_email: true,
  };
}
