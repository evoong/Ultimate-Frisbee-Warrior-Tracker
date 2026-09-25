import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SECRET_KEY || ""
);

export const FREE_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function gameDateWithinFreeWindow(gameDate: string, now = Date.now()): boolean {
  return gameDate >= new Date(now - FREE_HISTORY_WINDOW_MS).toISOString().slice(0, 10);
}

export async function getOrgEffectiveTier(orgId: number): Promise<'free' | 'plus' | 'premium'> {
  const { data, error } = await supabase.rpc('effective_tier', { p_org_id: orgId });
  if (error) throw error;
  return (data as 'free' | 'plus' | 'premium') || 'free';
}

export async function consumeAiMessage(orgId: number): Promise<boolean> {
  const { data, error } = await supabase.rpc('consume_ai_message', { p_org_id: orgId });
  if (error) throw error;
  return data === true;
}

export async function refundAiMessage(orgId: number): Promise<void> {
  const { error } = await supabase.rpc('refund_ai_message', { p_org_id: orgId });
  if (error) throw error;
}