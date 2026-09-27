# Super Admin Support Console — Phase 1: Ownership & Access

## Summary
Admin-facing toolkit to unblock teams when ownership breaks (sole captain leaves/loses access), invite emails fail, or support needs to view a team's exact state without shared credentials.

## Actors
| Role | Capability |
|------|------------|
| `support` | Search orgs/users/players, view audit log, issue invite links, view-as team |
| `superadmin` | All above + captain transfer, org deletion, player merge, tier override |

## Operations Catalog (Phase 1)

### 1. Transfer Captain / Force Promote
**Problem**: Team loses sole captain (account deleted, email lost). `enforce_last_captain()` trigger blocks demotion/removal.
**Solution**: Service-role `transfer_captainship(org_id, new_captain_user_id)`:
1. Validate `new_captain_user_id` is already an `editor` or `member` of `org_id`.
2. Promote target to `captain` (direct `team_members` write).
3. Demote previous captain(s) to `editor`.
4. Audit row records `from_captain`, `to_captain`, `reason` (free-text).
**Gate**: `superadmin` only.

### 2. Direct Invite Link Generator
**Problem**: Invite emails bounce/spam, or support needs to hand a link to a captain over chat.
**Solution**: Admin UI button "Create invite link" on Org Detail:
1. Admin enters email + role (`editor`/`member`).
2. Backend inserts `team_invites` row, returns signed JWT or opaque token URL `/join/{token}`.
3. Link valid 14 days; shows "pending" on Org Detail until accepted.
4. Audit row records admin, email, role, token hash (not plain).
**Gate**: `support` + `superadmin`.

### 3. View-As (Read-Only Impersonation)
**Problem**: "I see X but user sees Y" — need exact user perspective without credentials.
**Solution**: Admin-only route `/admin/view-as/:userId`:
1. Admin clicks "View as" on User Detail or Org Detail.
2. Sets short-lived encrypted cookie `ufwt_view_as=<userId>` (TTL 10 min).
3. Backend mints a short-lived, read-only support session scoped to target identity; ordinary customer writes reject this session type.
4. `AuthContext` reads the support session and loads target identity/memberships through its normal session flow.
5. Banner: "Viewing as <email> — [Exit]". Exit revokes support session and returns to admin.
**Gate**: `support` + `superadmin`.

## UI Structure (Full-Screen `/admin`)

```
/admin                    Search (org/user/player)
/admin/org/:orgId         Org Detail: members, invites, teams, counts, legacy members
   ├── Members tab        Table: email, role, since — actions: promote/demote/remove
   ├── Invites tab        Table: email, role, expires — actions: revoke, copy link
   ├── Teams tab          List: name, id — link to team-level detail later
   ├── View As            Button → opens /admin/view-as/:captainId in new tab
   └── Transfer Captain   Button (superadmin only) → modal with member picker + reason
/admin/user/:userId       User Detail: memberships, player links, pending invites, feedback count
/admin/audit              Paginated table: at, admin, operation, target, result, error
/admin/view-as/:userId    Proxied app shell (no admin nav) with exit banner
```

## Backend Additions

### New RPCs (service-role only, revoked from anon/authenticated)
```sql
create function admin_transfer_captainship(
  p_org_id bigint,
  p_new_captain_id uuid,
  p_reason text
) returns jsonb security definer set search_path = '';

create function admin_create_invite_link(
  p_org_id bigint,
  p_email text,
  p_role text
) returns jsonb security definer set search_path = '';
```

### New Admin Operations
| Name | minRole | Input |
|------|---------|-------|
| `transfer_captainship` | superadmin | `{org_id, new_captain_user_id, reason}` |
| `create_invite_link` | support | `{org_id, email, role}` |

### New Read Endpoints (readonly role)
| Path | Returns |
|------|---------|
| `/admin/view-as/eligibility/:userId` | `{eligible: true, teams: [{org_id, name, role}]}` |

## Audit Requirements
- Every mutation (`transfer_captainship`, `create_invite_link`) writes `admin_audit_log` with `admin_id`, `admin_role`, `operation`, `target`, `before`, `after`, `result`, `request_id`.
- `view_as` session start/end logged (no mutation, result `ok`).

## Security Notes
- `view_as` cookie HttpOnly, Secure, SameSite=Lax, scoped to admin subdomain; cleared on logout or explicit Exit.
- Invite link tokens: 256-bit random, stored hashed in `team_invites.invite_token_hash` (new column), never logged plain.
- Captain transfer demotes all other captains to `editor`; target must already be member/editor (cannot jump from outsider to captain).

## Testing
| Test | Expectation |
|------|-------------|
| Transfer captain without superadmin | 403 |
| Transfer to non-member | 400 "Target must be existing member/editor" |
| Create invite link without support | 403 |
| View-as on non-member user | 403 "Target holds no team membership" |
| View-as session expires after 10 min | Redirect to `/admin` |
| Audit row created for each mutation | Verified in `admin_audit_log` |

## Out of Scope (Future Phases)
- Event/game retroactive edits (Phase 3)
- JAM sync conflict resolution (Phase 2)
- Tier override / comping (Phase 4)
- Bulk operations
- Two-person approval for org deletion