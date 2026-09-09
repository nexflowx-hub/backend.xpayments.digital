-- XPAYMENTS Control Plane V1
-- Identity, revocable sessions, RBAC metadata, audit log and approval queue.
-- Applied to production Supabase on 2026-09-08 before runtime deployment.

create table if not exists public.control_plane_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  password_hash text not null,
  role text not null default 'READ_ONLY',
  permissions jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  last_login_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint control_plane_users_role_check check (role in ('SUPER_ADMIN','OPERATIONS','FINANCE','RISK','SUPPORT','EXPERT_OPS','READ_ONLY')),
  constraint control_plane_users_status_check check (status in ('active','disabled','locked'))
);

create unique index if not exists control_plane_users_email_lower_uidx on public.control_plane_users (lower(email));

create table if not exists public.control_plane_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.control_plane_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ip_address text null,
  user_agent text null
);
create index if not exists control_plane_sessions_user_idx on public.control_plane_sessions(user_id, created_at desc);
create index if not exists control_plane_sessions_active_idx on public.control_plane_sessions(token_hash, expires_at) where revoked_at is null;

create table if not exists public.control_plane_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid null references public.control_plane_users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text null,
  before_data jsonb null,
  after_data jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  ip_address text null,
  user_agent text null,
  created_at timestamptz not null default now()
);
create index if not exists control_plane_audit_actor_idx on public.control_plane_audit_logs(actor_user_id, created_at desc);
create index if not exists control_plane_audit_entity_idx on public.control_plane_audit_logs(entity_type, entity_id, created_at desc);
create index if not exists control_plane_audit_action_idx on public.control_plane_audit_logs(action, created_at desc);

create table if not exists public.control_plane_action_approvals (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  entity_type text not null,
  entity_id text null,
  payload jsonb not null default '{}'::jsonb,
  payload_hash text not null,
  status text not null default 'PENDING',
  requested_by uuid not null references public.control_plane_users(id) on delete restrict,
  approved_by uuid null references public.control_plane_users(id) on delete restrict,
  rejected_by uuid null references public.control_plane_users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_at timestamptz null,
  expires_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  constraint control_plane_action_approvals_status_check check (status in ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED'))
);
create index if not exists control_plane_approvals_status_idx on public.control_plane_action_approvals(status, requested_at desc);
create index if not exists control_plane_approvals_entity_idx on public.control_plane_action_approvals(entity_type, entity_id, requested_at desc);

create or replace function public.control_plane_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists control_plane_users_set_updated_at on public.control_plane_users;
create trigger control_plane_users_set_updated_at
before update on public.control_plane_users
for each row execute function public.control_plane_set_updated_at();

alter table public.control_plane_users enable row level security;
alter table public.control_plane_sessions enable row level security;
alter table public.control_plane_audit_logs enable row level security;
alter table public.control_plane_action_approvals enable row level security;

revoke all on public.control_plane_users from anon, authenticated;
revoke all on public.control_plane_sessions from anon, authenticated;
revoke all on public.control_plane_audit_logs from anon, authenticated;
revoke all on public.control_plane_action_approvals from anon, authenticated;
