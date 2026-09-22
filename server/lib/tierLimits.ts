import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SECRET_KEY || ""
);

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