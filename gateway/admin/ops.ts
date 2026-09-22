import { z } from 'zod'
import { sbGet, sbWrite } from '../supabaseRest.js'
import { AdminOpError, defineOperation, type AdminCtx, type AdminOperation } from './operations.js'

// The v1 operation catalog.
//
// These write to tables DIRECTLY with the service role rather than calling the
// membership RPCs. That is not a shortcut. set_member_role, remove_member,
// invite_member, revoke_invite, set_player_link and approve_claim are all
// security definer but gate on auth.uid() via assert_not_guest() and
// my_captain_team_ids(); under the service role auth.uid() is NULL, so
// my_captain_team_ids() is empty and set_member_role raises "only a captain
// can change roles". What those RPCs add over a direct write is CALLER
// AUTHORIZATION, which the admin boundary supplies differently, and INPUT
// VALIDATION, which each operation below re-implements.
//
// The invariant that actually matters is unaffected: enforce_last_captain() is
// a trigger (team_members_require_captain BEFORE UPDATE OR DELETE), so it
// fires on these direct writes exactly as it does on an RPC's writes.
//
// Note on identifiers: team_members.team_id, team_invites.team_id and
// player_links.team_id are all foreign keys to organizations(id). The tenant
// is the organization.

const TEAM_ROLES = ['captain', 'editor', 'member'] as const
// team_invites.role has check (role in ('editor', 'member')) -- an invite
// cannot grant captain. Reject it in the schema so the operator gets a clear
// message instead of a bare constraint violation.
const INVITE_ROLES = ['editor', 'member'] as const

// The last-captain trigger's message is the single most confusing error in
// this schema (see the gotcha in CLAUDE.md), so it is translated into a 409
// with actionable wording rather than becoming an opaque 500. The trigger's
// own text names only the team id, never row data, so it is safe to show.
function translate(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('must have at least one captain')) {
    throw new AdminOpError(
      message,
      409,
      'That team must have at least one captain. Promote another member first, then retry.'
    )
  }
  throw err
}

async function memberRow(ctx: AdminCtx, teamId: number, userId: string) {
  const rows = await sbGet(
    ctx.config,
    `/team_members?select=id,team_id,user_id,role,created_at` +
      `&team_id=eq.${teamId}&user_id=eq.${encodeURIComponent(userId)}`
  )
  return rows[0] ?? null
}

async function inviteRow(ctx: AdminCtx, inviteId: number) {
  const rows = await sbGet(
    ctx.config,
    `/team_invites?select=id,team_id,email,role,created_at,expires_at,accepted_at&id=eq.${inviteId}`
  )
  return rows[0] ?? null
}

async function linkRow(ctx: AdminCtx, playerId: number) {
  const rows = await sbGet(
    ctx.config,
    `/player_links?select=id,team_id,player_id,user_id,status,created_at&player_id=eq.${playerId}`
  )
  return rows[0] ?? null
}

const setMemberRole = defineOperation({
  name: 'set_member_role',
  minRole: 'support',
  input: z.object({
    team_id: z.number().int().positive(),
    user_id: z.string().uuid(),
    role: z.enum(TEAM_ROLES),
  }),
  target: i => ({ team_id: i.team_id, user_id: i.user_id, role: i.role }),
  preview: async (ctx, i) => ({
    current: await memberRow(ctx, i.team_id, i.user_id),
    next: { role: i.role },
  }),
  apply: async (ctx, i) => {
    const before = await memberRow(ctx, i.team_id, i.user_id)
    if (!before) {
      throw new AdminOpError(
        `user ${i.user_id} is not a member of organization ${i.team_id}`,
        404,
        'That person is not a member of this organization.'
      )
    }
    try {
      const rows = await sbWrite(
        ctx.config,
        'PATCH',
        `/team_members?team_id=eq.${i.team_id}&user_id=eq.${encodeURIComponent(i.user_id)}`,
        { role: i.role }
      )
      return { before, after: rows[0] ?? null }
    } catch (err) {
      translate(err)
    }
  },
})

const removeMember = defineOperation({
  name: 'remove_member',
  minRole: 'support',
  input: z.object({
    team_id: z.number().int().positive(),
    user_id: z.string().uuid(),
  }),
  target: i => ({ team_id: i.team_id, user_id: i.user_id }),
  preview: async (ctx, i) => ({ current: await memberRow(ctx, i.team_id, i.user_id) }),
  apply: async (ctx, i) => {
    const before = await memberRow(ctx, i.team_id, i.user_id)
    if (!before) {
      throw new AdminOpError(
        `user ${i.user_id} is not a member of organization ${i.team_id}`,
        404,
        'That person is not a member of this organization.'
      )
    }
    try {
      await sbWrite(
        ctx.config,
        'DELETE',
        `/team_members?team_id=eq.${i.team_id}&user_id=eq.${encodeURIComponent(i.user_id)}`
      )
      return { before, after: null }
    } catch (err) {
      translate(err)
    }
  },
})

const inviteMember = defineOperation({
  name: 'invite_member',
  minRole: 'support',
  input: z.object({
    team_id: z.number().int().positive(),
    // team_invites has check (email = lower(email)), so normalize here rather
    // than letting the constraint reject a perfectly reasonable input.
    email: z.string().email().transform(v => v.trim().toLowerCase()),
    role: z.enum(INVITE_ROLES),
  }),
  target: i => ({ team_id: i.team_id, email: i.email, role: i.role }),
  preview: async (ctx, i) => {
    const existing = await sbGet(
      ctx.config,
      `/team_invites?select=id,role,created_at,expires_at&team_id=eq.${i.team_id}` +
        `&email=eq.${encodeURIComponent(i.email)}&accepted_at=is.null`
    )
    return { pending: existing[0] ?? null, next: { role: i.role } }
  },
  apply: async (ctx, i) => {
    // team_invites_pending_unique is a partial unique index on
    // (team_id, email) where accepted_at is null, so a second pending invite
    // is a conflict rather than a duplicate row.
    const existing = await sbGet(
      ctx.config,
      `/team_invites?select=id&team_id=eq.${i.team_id}` +
        `&email=eq.${encodeURIComponent(i.email)}&accepted_at=is.null`
    )
    if (existing[0]) {
      throw new AdminOpError(
        `a pending invite already exists for ${i.email} on organization ${i.team_id}`,
        409,
        'That address already has a pending invite for this organization. Revoke it first.'
      )
    }
    const rows = await sbWrite(ctx.config, 'POST', '/team_invites', {
      team_id: i.team_id,
      email: i.email,
      role: i.role,
    })
    return { before: null, after: rows[0] ?? null }
  },
})

const revokeInvite = defineOperation({
  name: 'revoke_invite',
  minRole: 'support',
  input: z.object({ invite_id: z.number().int().positive() }),
  target: i => ({ invite_id: i.invite_id }),
  preview: async (ctx, i) => ({ current: await inviteRow(ctx, i.invite_id) }),
  apply: async (ctx, i) => {
    const before = await inviteRow(ctx, i.invite_id)
    if (!before) {
      throw new AdminOpError(`invite ${i.invite_id} does not exist`, 404, 'That invite no longer exists.')
    }
    if (before.accepted_at) {
      // Revoking an accepted invite would be theatre: the membership it
      // created already exists and is removed with remove_member instead.
      throw new AdminOpError(
        `invite ${i.invite_id} was already accepted at ${before.accepted_at}`,
        409,
        'That invite was already accepted. Remove the membership instead.'
      )
    }
    await sbWrite(ctx.config, 'DELETE', `/team_invites?id=eq.${i.invite_id}&accepted_at=is.null`)
    return { before, after: null }
  },
})

const setPlayerLink = defineOperation({
  name: 'set_player_link',
  minRole: 'support',
  input: z.object({
    player_id: z.number().int().positive(),
    user_id: z.string().uuid(),
  }),
  target: i => ({ player_id: i.player_id, user_id: i.user_id }),
  preview: async (ctx, i) => ({ current: await linkRow(ctx, i.player_id) }),
  apply: async (ctx, i) => {
    const players = await sbGet(
      ctx.config,
      `/players?select=id,display_name,organization_id&id=eq.${i.player_id}`
    )
    const player = players[0]
    if (!player) {
      throw new AdminOpError(`player ${i.player_id} does not exist`, 404, 'That player does not exist.')
    }

    // player_links carries unique (player_id) AND unique (team_id, user_id).
    // The second one is the trap: this user may already be linked to a
    // DIFFERENT player in the same organization, and repointing would violate
    // it. Report that explicitly rather than letting Postgres raise 23505.
    const clash = await sbGet(
      ctx.config,
      `/player_links?select=id,player_id&team_id=eq.${player.organization_id}` +
        `&user_id=eq.${encodeURIComponent(i.user_id)}&player_id=neq.${i.player_id}`
    )
    if (clash[0]) {
      throw new AdminOpError(
        `user ${i.user_id} is already linked to player ${clash[0].player_id} in organization ${player.organization_id}`,
        409,
        `That account is already linked to a different player in this organization (player ${clash[0].player_id}). Unlink that one first.`
      )
    }

    const before = await linkRow(ctx, i.player_id)
    const after = before
      ? (await sbWrite(ctx.config, 'PATCH', `/player_links?player_id=eq.${i.player_id}`, {
          user_id: i.user_id,
          status: 'approved',
        }))[0]
      : (await sbWrite(ctx.config, 'POST', '/player_links', {
          team_id: player.organization_id,
          player_id: i.player_id,
          user_id: i.user_id,
          status: 'approved',
        }))[0]
    return { before, after: after ?? null }
  },
})

const approvePlayerLink = defineOperation({
  name: 'approve_player_link',
  minRole: 'support',
  input: z.object({ link_id: z.number().int().positive() }),
  target: i => ({ link_id: i.link_id }),
  preview: async (ctx, i) => {
    const rows = await sbGet(
      ctx.config,
      `/player_links?select=id,team_id,player_id,user_id,status&id=eq.${i.link_id}`
    )
    return { current: rows[0] ?? null, next: { status: 'approved' } }
  },
  apply: async (ctx, i) => {
    const rows = await sbGet(
      ctx.config,
      `/player_links?select=id,team_id,player_id,user_id,status&id=eq.${i.link_id}`
    )
    const before = rows[0]
    if (!before) {
      throw new AdminOpError(`player link ${i.link_id} does not exist`, 404, 'That link no longer exists.')
    }
    const after = await sbWrite(ctx.config, 'PATCH', `/player_links?id=eq.${i.link_id}`, {
      status: 'approved',
    })
    return { before, after: after[0] ?? null }
  },
})

const mergePlayers = defineOperation({
  name: 'merge_players',
  minRole: 'superadmin',
  input: z
    .object({
      keep_id: z.number().int().positive(),
      merge_id: z.number().int().positive(),
    })
    // Caught here so the operator sees a schema error rather than the RPC's
    // "cannot merge player N into itself" after a round trip.
    .refine(i => i.keep_id !== i.merge_id, {
      message: 'keep_id and merge_id must differ',
    }),
  target: i => ({ keep_id: i.keep_id, merge_id: i.merge_id }),
  preview: async (ctx, i) => {
    const both = await sbGet(
      ctx.config,
      `/players?select=id,display_name,number,organization_id&id=in.(${i.keep_id},${i.merge_id})`
    )
    return {
      keep: both.find((p: any) => p.id === i.keep_id) ?? null,
      merge: both.find((p: any) => p.id === i.merge_id) ?? null,
      // The merge itself reports exact per-table counts; a preview cannot
      // compute them without doing the work, so it states the rule instead.
      rule: 'Where a unique constraint would collide, the keeper’s row wins and the merged player’s row is deleted.',
    }
  },
  apply: async (ctx, i) => {
    const before = await sbGet(
      ctx.config,
      `/players?select=id,display_name,number,organization_id&id=in.(${i.keep_id},${i.merge_id})`
    )
    const result = await sbWrite(ctx.config, 'POST', '/rpc/admin_merge_players', {
      p_keep_id: i.keep_id,
      p_merge_id: i.merge_id,
    })
    return { before, after: result }
  },
})

const deleteOrg = defineOperation({
  name: 'delete_org',
  minRole: 'superadmin',
  input: z.object({
    organization_id: z.number().int().positive(),
    // Typed-name confirmation. Verified against the real name in apply, so a
    // mis-click on the wrong row cannot destroy a tenant.
    confirm_name: z.string().min(1),
  }),
  target: i => ({ organization_id: i.organization_id }),
  preview: async (ctx, i) =>
    sbWrite(ctx.config, 'POST', '/rpc/admin_preview_delete_org', {
      p_org_id: i.organization_id,
    }),
  apply: async (ctx, i) => {
    const orgs = await sbGet(
      ctx.config,
      `/organizations?select=id,name,is_public,created_at&id=eq.${i.organization_id}`
    )
    const org = orgs[0]
    if (!org) {
      throw new AdminOpError(
        `organization ${i.organization_id} does not exist`,
        404,
        'That organization does not exist.'
      )
    }
    if (org.name !== i.confirm_name) {
      throw new AdminOpError(
        `confirm_name ${JSON.stringify(i.confirm_name)} does not match ${JSON.stringify(org.name)}`,
        409,
        'The typed name does not match this organization’s name.'
      )
    }
    // Captured before the delete: once the cascade runs there is nothing left
    // to count, and the audit row is the only remaining record of the size of
    // what was removed.
    const dependents = await sbWrite(ctx.config, 'POST', '/rpc/admin_preview_delete_org', {
      p_org_id: i.organization_id,
    })
    await sbWrite(ctx.config, 'DELETE', `/organizations?id=eq.${i.organization_id}`)
    return { before: { organization: org, dependents }, after: null }
  },
})

const transferCaptainship = defineOperation({
  name: 'transfer_captainship',
  minRole: 'superadmin',
  input: z.object({
    org_id: z.number().int().positive(),
    new_captain_user_id: z.string().uuid(),
    reason: z.string().min(5),
  }),
  target: i => ({ org_id: i.org_id, new_captain: i.new_captain_user_id }),
  preview: async (ctx, i) => ({
    current_captain: await sbGet(ctx.config, `/team_members?select=user_id&team_id=eq.${i.org_id}&role=eq.captain`),
    next_captain: i.new_captain_user_id,
  }),
  apply: async (ctx, i) => {
    try {
      const result = await sbWrite(ctx.config, 'POST', '/rpc/admin_transfer_captainship', {
        p_org_id: i.org_id,
        p_new_captain_id: i.new_captain_user_id,
        p_reason: i.reason,
      });
      return { before: null, after: result };
    } catch (err) {
      translate(err);
    }
  },
});

const createInviteToken = defineOperation({
  name: 'create_invite_link',
  minRole: 'support',
  input: z.object({
    org_id: z.number().int().positive(),
    email: z.string().email().transform(v => v.trim().toLowerCase()),
    role: z.enum(INVITE_ROLES),
  }),
  target: i => ({ org_id: i.org_id, email: i.email, role: i.role }),
  preview: async (ctx, i) => ({ exists: await sbGet(ctx.config, `/team_invites?team_id=eq.${i.org_id}&email=eq.${encodeURIComponent(i.email)}`) }),
  apply: async (ctx, i) => {
    const token = crypto.randomUUID();
    const data = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    const result = await sbWrite(ctx.config, 'POST', '/rpc/admin_create_invite_token', {
      p_org_id: i.org_id,
      p_email: i.email,
      p_role: i.role,
      p_token_hash: hash,
    });
    return { before: null, after: { ...result, link: `/join/${token}` } };
  },
});

export const ADMIN_OPERATIONS: AdminOperation<any>[] = [
  setMemberRole,
  removeMember,
  inviteMember,
  revokeInvite,
  setPlayerLink,
  approvePlayerLink,
  mergePlayers,
  deleteOrg,
  transferCaptainship,
  createInviteToken,
]
