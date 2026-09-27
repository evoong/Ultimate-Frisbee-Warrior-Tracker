import { expect, test } from 'vitest';
import { supabase } from '../lib/supabase';

test('can activate 30-day free trial for organization', async () => {
  // Setup: create org, assume ID 999
  const { data: org } = await supabase.from('organizations').insert({ name: 'Trial Org' }).select().single();
  const orgId = org.id;

  // Act: start trial
  const res = await fetch('/api/org/trial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: orgId }),
  });

  // Assert
  expect(res.ok).toBe(true);
  const { data: updated } = await supabase.from('organizations').select('trial_ends_at, plan_source').eq('id', orgId).single();
  expect(updated.plan_source).toBe('trial');
  expect(updated.trial_ends_at).toBeDefined();
});
