


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."get_secret"("secret_name" "text") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = secret_name
  limit 1
$$;


ALTER FUNCTION "public"."get_secret"("secret_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_org_member"("org_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.organization_members
    where organization_id = org_id
      and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;


ALTER FUNCTION "public"."is_org_member"("org_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_org_owner"("org_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.organization_members
    where organization_id = org_id
      and role = 'owner'
      and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;


ALTER FUNCTION "public"."is_org_owner"("org_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_organizations"() RETURNS TABLE("organization_id" bigint, "name" "text", "role" "text", "is_public" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.name, m.role, o.is_public
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;


ALTER FUNCTION "public"."my_organizations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."org_is_public"("org_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce((select is_public from public.organizations where id = org_id), false);
$$;


ALTER FUNCTION "public"."org_is_public"("org_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_game_opponent_team"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_name text := nullif(trim(coalesce(new.opponent, '')), '');
begin
  if new.season_id is null or v_name is null then
    return new;
  end if;
  if new.opponent_team_id is not null and exists (
    select 1 from public.league_teams lt
    where lt.id = new.opponent_team_id and lt.season_id = new.season_id
  ) then
    return new;
  end if;
  insert into public.league_teams (season_id, organization_id, name)
  values (new.season_id, new.organization_id, v_name)
  on conflict (season_id, name) do nothing;
  select id into new.opponent_team_id
  from public.league_teams
  where season_id = new.season_id and name = v_name;
  return new;
end
$$;


ALTER FUNCTION "public"."resolve_game_opponent_team"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_audit_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_actor text := nullif(coalesce(auth.jwt() ->> 'email', ''), '');
begin
  if tg_op = 'INSERT' then
    if new.created_at is null then new.created_at := now(); end if;
    if new.created_by is null then new.created_by := v_actor; end if;
    new.updated_at := new.created_at;
    if new.updated_by is null then new.updated_by := v_actor; end if;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := v_actor;
  end if;
  return new;
end
$$;


ALTER FUNCTION "public"."set_audit_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_game_league_pair"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_us bigint;
  v_stage text;
begin
  if tg_op = 'DELETE' then
    delete from public.league_games where our_game_id = old.id;
    return old;
  end if;
  if new.season_id is null then
    delete from public.league_games where our_game_id = new.id;
    return new;
  end if;

  insert into public.league_teams (season_id, organization_id, name, is_us)
  select s.id, new.organization_id, coalesce(t.name, 'Warriors'), true
  from public.seasons s
  left join public.teams t on t.id = s.team_id
  where s.id = new.season_id
  on conflict do nothing;

  select id into v_us
  from public.league_teams
  where season_id = new.season_id and is_us;

  v_stage := case when new.game_type ilike 'playoff%' then 'playoff' else 'regular' end;

  update public.league_games set
    season_id = new.season_id,
    home_team_id = v_us,
    away_team_id = new.opponent_team_id,
    game_date = new.game_date,
    game_time = new.game_time,
    stage = v_stage
  where our_game_id = new.id;
  if not found then
    insert into public.league_games
      (season_id, organization_id, home_team_id, away_team_id, game_date, game_time, stage, our_game_id)
    values
      (new.season_id, new.organization_id, v_us, new.opponent_team_id, new.game_date, new.game_time, v_stage, new.id);
  end if;
  return new;
end
$$;


ALTER FUNCTION "public"."sync_game_league_pair"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_strategy_play"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_play_id bigint;
begin
  if tg_table_name = 'strategy_steps' then
    v_play_id := coalesce(new.play_id, old.play_id);
  else
    select play_id into v_play_id
    from public.strategy_steps
    where id = coalesce(new.step_id, old.step_id);
  end if;

  update public.strategy_plays set updated_at = now() where id = v_play_id;
  return coalesce(new, old);
end
$$;


ALTER FUNCTION "public"."touch_strategy_play"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."calendar_sources" (
    "id" bigint NOT NULL,
    "organizer" "text" NOT NULL,
    "calendar_url" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."calendar_sources" OWNER TO "postgres";


ALTER TABLE "public"."calendar_sources" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."calendar_sources_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."chat_logs" (
    "id" bigint NOT NULL,
    "session_id" "text" NOT NULL,
    "user_id" "text",
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" bigint NOT NULL,
    CONSTRAINT "chat_logs_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"])))
);


ALTER TABLE "public"."chat_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."chat_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."chat_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."chat_logs_id_seq" OWNED BY "public"."chat_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."event_types" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text"
);


ALTER TABLE "public"."event_types" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."event_types_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."event_types_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."event_types_id_seq" OWNED BY "public"."event_types"."id";



CREATE TABLE IF NOT EXISTS "public"."game_attendance" (
    "id" integer NOT NULL,
    "game_id" integer NOT NULL,
    "player_id" integer NOT NULL,
    "in" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."game_attendance" OWNER TO "postgres";


ALTER TABLE "public"."game_attendance" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."game_attendance_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."game_events" (
    "id" integer NOT NULL,
    "game_id" integer NOT NULL,
    "player_id" integer,
    "related_player_id" integer,
    "event_type" "text",
    "event_timestamp" timestamp with time zone DEFAULT "now"(),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."game_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."game_events_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."game_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."game_events_id_seq" OWNED BY "public"."game_events"."id";



CREATE TABLE IF NOT EXISTS "public"."game_lineup_groups" (
    "id" bigint NOT NULL,
    "game_id" bigint NOT NULL,
    "lineup_name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."game_lineup_groups" OWNER TO "postgres";


ALTER TABLE "public"."game_lineup_groups" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."game_lineup_groups_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."game_lineups" (
    "id" integer NOT NULL,
    "game_id" integer NOT NULL,
    "player_id" integer NOT NULL,
    "lineup_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "role" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."game_lineups" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."game_lineups_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."game_lineups_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."game_lineups_id_seq" OWNED BY "public"."game_lineups"."id";



CREATE TABLE IF NOT EXISTS "public"."games" (
    "id" integer NOT NULL,
    "season_id" integer,
    "opponent" "text",
    "game_date" "date",
    "game_time" time without time zone,
    "game_type" "text",
    "our_score" integer DEFAULT 0,
    "their_score" integer DEFAULT 0,
    "result" "text",
    "notes" "text",
    "outcome_override" "text",
    "jam_uid" "text",
    "opponent_team_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."games" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."games_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."games_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."games_id_seq" OWNED BY "public"."games"."id";



CREATE TABLE IF NOT EXISTS "public"."jam_sync_conflicts" (
    "id" bigint NOT NULL,
    "jam_uid" "text" NOT NULL,
    "opponent" "text" NOT NULL,
    "event_date" "date" NOT NULL,
    "event_time" time without time zone NOT NULL,
    "location" "text",
    "existing_game_id" integer,
    "reason" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "organizer" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."jam_sync_conflicts" OWNER TO "postgres";


ALTER TABLE "public"."jam_sync_conflicts" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."jam_sync_conflicts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."league_games" (
    "id" bigint NOT NULL,
    "season_id" bigint NOT NULL,
    "home_team_id" bigint,
    "away_team_id" bigint,
    "home_score" integer,
    "away_score" integer,
    "game_date" "date",
    "game_time" time without time zone,
    "location" "text",
    "stage" "text" DEFAULT 'regular'::"text" NOT NULL,
    "round" "text",
    "bracket_pos" integer,
    "next_game_id" bigint,
    "next_slot" "text",
    "our_game_id" bigint,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL,
    CONSTRAINT "league_games_next_slot_check" CHECK (("next_slot" = ANY (ARRAY['home'::"text", 'away'::"text"]))),
    CONSTRAINT "league_games_stage_check" CHECK (("stage" = ANY (ARRAY['regular'::"text", 'playoff'::"text"]))),
    CONSTRAINT "league_games_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'final'::"text"])))
);


ALTER TABLE "public"."league_games" OWNER TO "postgres";


ALTER TABLE "public"."league_games" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."league_games_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."league_teams" (
    "id" bigint NOT NULL,
    "season_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "is_us" boolean DEFAULT false NOT NULL,
    "color" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."league_teams" OWNER TO "postgres";


ALTER TABLE "public"."league_teams" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."league_teams_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lineup_template_groups" (
    "id" bigint NOT NULL,
    "template_id" bigint NOT NULL,
    "organization_id" bigint NOT NULL,
    "lineup_name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."lineup_template_groups" OWNER TO "postgres";


ALTER TABLE "public"."lineup_template_groups" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."lineup_template_groups_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lineup_template_players" (
    "id" bigint NOT NULL,
    "template_id" bigint NOT NULL,
    "organization_id" bigint NOT NULL,
    "lineup_name" "text" NOT NULL,
    "player_id" integer NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "role" "text"
);


ALTER TABLE "public"."lineup_template_players" OWNER TO "postgres";


ALTER TABLE "public"."lineup_template_players" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."lineup_template_players_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lineup_templates" (
    "id" bigint NOT NULL,
    "organization_id" bigint NOT NULL,
    "season_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text"
);


ALTER TABLE "public"."lineup_templates" OWNER TO "postgres";


ALTER TABLE "public"."lineup_templates" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."lineup_templates_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."organization_members" (
    "id" bigint NOT NULL,
    "organization_id" bigint NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organization_members_email_check" CHECK (("email" = "lower"("email"))),
    CONSTRAINT "organization_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."organization_members" OWNER TO "postgres";


ALTER TABLE "public"."organization_members" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."organization_members_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "is_public" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text"
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


ALTER TABLE "public"."organizations" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."organizations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."players" (
    "id" integer NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "display_name" "text" NOT NULL,
    "gender_match" "text",
    "phone" "text",
    "is_sub" boolean DEFAULT false,
    "position" "text",
    "photo_url" "text",
    "number" "text",
    "first_name_edit" "text",
    "last_name_edit" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."players" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."players_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."players_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."players_id_seq" OWNED BY "public"."players"."id";



CREATE TABLE IF NOT EXISTS "public"."season_players" (
    "id" integer NOT NULL,
    "season_id" integer NOT NULL,
    "player_id" integer NOT NULL,
    "jersey_number" "text",
    "active" boolean DEFAULT true,
    "role" "text",
    "is_sub" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."season_players" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."season_players_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."season_players_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."season_players_id_seq" OWNED BY "public"."season_players"."id";



CREATE TABLE IF NOT EXISTS "public"."seasons" (
    "id" integer NOT NULL,
    "team_id" integer,
    "name" "text",
    "year" integer,
    "start_date" "date",
    "end_date" "date",
    "location" "text",
    "league_name" "text",
    "organizer" "text",
    "default_game_time" time without time zone,
    "win_points" integer DEFAULT 2 NOT NULL,
    "tie_points" integer DEFAULT 1 NOT NULL,
    "loss_points" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."seasons" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."seasons_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."seasons_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."seasons_id_seq" OWNED BY "public"."seasons"."id";



CREATE TABLE IF NOT EXISTS "public"."standings" (
    "id" integer NOT NULL,
    "season_id" integer,
    "team_name" "text",
    "games_played" integer DEFAULT 0,
    "wins" integer DEFAULT 0,
    "losses" integer DEFAULT 0,
    "ties" integer DEFAULT 0,
    "default_losses" integer DEFAULT 0,
    "points" integer DEFAULT 0,
    "points_for" integer DEFAULT 0,
    "points_against" integer DEFAULT 0,
    "point_differential" integer DEFAULT 0
);


ALTER TABLE "public"."standings" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."standings_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."standings_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."standings_id_seq" OWNED BY "public"."standings"."id";



CREATE TABLE IF NOT EXISTS "public"."strategy_arrows" (
    "id" bigint NOT NULL,
    "step_id" bigint NOT NULL,
    "arrow_type" "text" DEFAULT 'run'::"text" NOT NULL,
    "x1" real NOT NULL,
    "y1" real NOT NULL,
    "x2" real NOT NULL,
    "y2" real NOT NULL,
    "cx" real NOT NULL,
    "cy" real NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "start_player_id" integer,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "start_opponent_id" bigint,
    "organization_id" bigint NOT NULL,
    CONSTRAINT "strategy_arrows_arrow_type_check" CHECK (("arrow_type" = ANY (ARRAY['run'::"text", 'throw'::"text"]))),
    CONSTRAINT "strategy_arrows_cx_check" CHECK ((("cx" >= (0)::double precision) AND ("cx" <= (1)::double precision))),
    CONSTRAINT "strategy_arrows_cy_check" CHECK ((("cy" >= (0)::double precision) AND ("cy" <= (1)::double precision))),
    CONSTRAINT "strategy_arrows_single_anchor" CHECK ((("start_player_id" IS NULL) OR ("start_opponent_id" IS NULL))),
    CONSTRAINT "strategy_arrows_x1_check" CHECK ((("x1" >= (0)::double precision) AND ("x1" <= (1)::double precision))),
    CONSTRAINT "strategy_arrows_x2_check" CHECK ((("x2" >= (0)::double precision) AND ("x2" <= (1)::double precision))),
    CONSTRAINT "strategy_arrows_y1_check" CHECK ((("y1" >= (0)::double precision) AND ("y1" <= (1)::double precision))),
    CONSTRAINT "strategy_arrows_y2_check" CHECK ((("y2" >= (0)::double precision) AND ("y2" <= (1)::double precision)))
);


ALTER TABLE "public"."strategy_arrows" OWNER TO "postgres";


ALTER TABLE "public"."strategy_arrows" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_arrows_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."strategy_highlights" (
    "id" bigint NOT NULL,
    "step_id" bigint NOT NULL,
    "points" "jsonb" NOT NULL,
    "color" "text" DEFAULT '#f59e0b'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL,
    "is_straight" boolean DEFAULT false NOT NULL,
    "locked" boolean DEFAULT false NOT NULL,
    CONSTRAINT "strategy_highlights_points_check" CHECK ((("jsonb_typeof"("points") = 'array'::"text") AND ("jsonb_array_length"("points") >= 3)))
);


ALTER TABLE "public"."strategy_highlights" OWNER TO "postgres";


ALTER TABLE "public"."strategy_highlights" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_highlights_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."strategy_lines" (
    "id" bigint NOT NULL,
    "step_id" bigint NOT NULL,
    "organization_id" bigint NOT NULL,
    "points" "jsonb" NOT NULL,
    "color" "text" DEFAULT '#f59e0b'::"text" NOT NULL,
    "is_straight" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "locked" boolean DEFAULT false NOT NULL,
    CONSTRAINT "strategy_lines_points_check" CHECK ((("jsonb_typeof"("points") = 'array'::"text") AND ("jsonb_array_length"("points") >= 2)))
);


ALTER TABLE "public"."strategy_lines" OWNER TO "postgres";


ALTER TABLE "public"."strategy_lines" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_lines_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."strategy_opponent_markers" (
    "id" bigint NOT NULL,
    "step_id" bigint NOT NULL,
    "label" "text" NOT NULL,
    "x" real NOT NULL,
    "y" real NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL,
    CONSTRAINT "strategy_opponent_markers_x_check" CHECK ((("x" >= (0)::double precision) AND ("x" <= (1)::double precision))),
    CONSTRAINT "strategy_opponent_markers_y_check" CHECK ((("y" >= (0)::double precision) AND ("y" <= (1)::double precision)))
);


ALTER TABLE "public"."strategy_opponent_markers" OWNER TO "postgres";


ALTER TABLE "public"."strategy_opponent_markers" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_opponent_markers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."strategy_plays" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "game_id" bigint,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."strategy_plays" OWNER TO "postgres";


ALTER TABLE "public"."strategy_plays" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_plays_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."strategy_positions" (
    "id" bigint NOT NULL,
    "player_id" integer NOT NULL,
    "x" real NOT NULL,
    "y" real NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "step_id" bigint NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL,
    CONSTRAINT "strategy_positions_x_check" CHECK ((("x" >= (0)::double precision) AND ("x" <= (1)::double precision))),
    CONSTRAINT "strategy_positions_y_check" CHECK ((("y" >= (0)::double precision) AND ("y" <= (1)::double precision)))
);


ALTER TABLE "public"."strategy_positions" OWNER TO "postgres";


ALTER TABLE "public"."strategy_positions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_positions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."strategy_steps" (
    "id" bigint NOT NULL,
    "play_id" bigint NOT NULL,
    "step_number" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."strategy_steps" OWNER TO "postgres";


ALTER TABLE "public"."strategy_steps" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_steps_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."strategy_text_boxes" (
    "id" bigint NOT NULL,
    "step_id" bigint NOT NULL,
    "text" "text" DEFAULT ''::"text" NOT NULL,
    "x" real NOT NULL,
    "y" real NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL,
    "color" "text",
    "filled" boolean DEFAULT false NOT NULL,
    "width" numeric DEFAULT 0.12 NOT NULL,
    CONSTRAINT "strategy_text_boxes_x_check" CHECK ((("x" >= (0)::double precision) AND ("x" <= (1)::double precision))),
    CONSTRAINT "strategy_text_boxes_y_check" CHECK ((("y" >= (0)::double precision) AND ("y" <= (1)::double precision)))
);


ALTER TABLE "public"."strategy_text_boxes" OWNER TO "postgres";


ALTER TABLE "public"."strategy_text_boxes" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."strategy_text_boxes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."teams" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "organization_id" bigint NOT NULL
);


ALTER TABLE "public"."teams" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."teams_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."teams_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."teams_id_seq" OWNED BY "public"."teams"."id";



ALTER TABLE ONLY "public"."chat_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."chat_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."event_types" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."event_types_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."game_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."game_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."game_lineups" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."game_lineups_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."games" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."games_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."players" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."players_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."season_players" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."season_players_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."seasons" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."seasons_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."standings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."standings_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."teams" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."teams_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."calendar_sources"
    ADD CONSTRAINT "calendar_sources_organizer_key" UNIQUE ("organizer");



ALTER TABLE ONLY "public"."calendar_sources"
    ADD CONSTRAINT "calendar_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_logs"
    ADD CONSTRAINT "chat_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_types"
    ADD CONSTRAINT "event_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_attendance"
    ADD CONSTRAINT "game_attendance_game_id_player_id_key" UNIQUE ("game_id", "player_id");



ALTER TABLE ONLY "public"."game_attendance"
    ADD CONSTRAINT "game_attendance_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_events"
    ADD CONSTRAINT "game_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_lineup_groups"
    ADD CONSTRAINT "game_lineup_groups_game_id_lineup_name_key" UNIQUE ("game_id", "lineup_name");



ALTER TABLE ONLY "public"."game_lineup_groups"
    ADD CONSTRAINT "game_lineup_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_lineups"
    ADD CONSTRAINT "game_lineups_game_id_player_id_lineup_name_key" UNIQUE ("game_id", "player_id", "lineup_name");



ALTER TABLE ONLY "public"."game_lineups"
    ADD CONSTRAINT "game_lineups_game_player_lineup_unique" UNIQUE ("game_id", "player_id", "lineup_name");



ALTER TABLE ONLY "public"."game_lineups"
    ADD CONSTRAINT "game_lineups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_jam_uid_key" UNIQUE ("jam_uid");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jam_sync_conflicts"
    ADD CONSTRAINT "jam_sync_conflicts_jam_uid_key" UNIQUE ("jam_uid");



ALTER TABLE ONLY "public"."jam_sync_conflicts"
    ADD CONSTRAINT "jam_sync_conflicts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_our_game_id_key" UNIQUE ("our_game_id");



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."league_teams"
    ADD CONSTRAINT "league_teams_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."league_teams"
    ADD CONSTRAINT "league_teams_season_id_name_key" UNIQUE ("season_id", "name");



ALTER TABLE ONLY "public"."lineup_template_groups"
    ADD CONSTRAINT "lineup_template_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lineup_template_groups"
    ADD CONSTRAINT "lineup_template_groups_template_id_lineup_name_key" UNIQUE ("template_id", "lineup_name");



ALTER TABLE ONLY "public"."lineup_template_players"
    ADD CONSTRAINT "lineup_template_players_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lineup_templates"
    ADD CONSTRAINT "lineup_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lineup_templates"
    ADD CONSTRAINT "lineup_templates_season_id_name_key" UNIQUE ("season_id", "name");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_email_key" UNIQUE ("organization_id", "email");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."players"
    ADD CONSTRAINT "players_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."season_players"
    ADD CONSTRAINT "season_players_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."season_players"
    ADD CONSTRAINT "season_players_season_id_player_id_key" UNIQUE ("season_id", "player_id");



ALTER TABLE ONLY "public"."season_players"
    ADD CONSTRAINT "season_players_season_player_unique" UNIQUE ("season_id", "player_id");



ALTER TABLE ONLY "public"."seasons"
    ADD CONSTRAINT "seasons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."standings"
    ADD CONSTRAINT "standings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_arrows"
    ADD CONSTRAINT "strategy_arrows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_highlights"
    ADD CONSTRAINT "strategy_highlights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_lines"
    ADD CONSTRAINT "strategy_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_opponent_markers"
    ADD CONSTRAINT "strategy_opponent_markers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_plays"
    ADD CONSTRAINT "strategy_plays_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_positions"
    ADD CONSTRAINT "strategy_positions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_positions"
    ADD CONSTRAINT "strategy_positions_step_id_player_id_key" UNIQUE ("step_id", "player_id");



ALTER TABLE ONLY "public"."strategy_steps"
    ADD CONSTRAINT "strategy_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_steps"
    ADD CONSTRAINT "strategy_steps_play_id_step_number_key" UNIQUE ("play_id", "step_number");



ALTER TABLE ONLY "public"."strategy_text_boxes"
    ADD CONSTRAINT "strategy_text_boxes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_pkey" PRIMARY KEY ("id");



CREATE INDEX "chat_logs_session_id_idx" ON "public"."chat_logs" USING "btree" ("session_id", "created_at");



CREATE INDEX "idx_chat_logs_session_created" ON "public"."chat_logs" USING "btree" ("session_id", "created_at");



CREATE INDEX "idx_game_attendance_player_id" ON "public"."game_attendance" USING "btree" ("player_id");



CREATE INDEX "idx_game_events_game_id" ON "public"."game_events" USING "btree" ("game_id");



CREATE INDEX "idx_game_events_player_id" ON "public"."game_events" USING "btree" ("player_id");



CREATE INDEX "idx_game_events_related_player_id" ON "public"."game_events" USING "btree" ("related_player_id");



CREATE INDEX "idx_game_lineups_player_id" ON "public"."game_lineups" USING "btree" ("player_id");



CREATE INDEX "idx_games_season_id" ON "public"."games" USING "btree" ("season_id");



CREATE INDEX "idx_season_players_player_id" ON "public"."season_players" USING "btree" ("player_id");



CREATE INDEX "idx_seasons_team_id" ON "public"."seasons" USING "btree" ("team_id");



CREATE INDEX "idx_standings_season_id" ON "public"."standings" USING "btree" ("season_id");



CREATE INDEX "league_games_season_idx" ON "public"."league_games" USING "btree" ("season_id");



CREATE UNIQUE INDEX "league_teams_one_us_per_season" ON "public"."league_teams" USING "btree" ("season_id") WHERE "is_us";



CREATE OR REPLACE TRIGGER "calendar_sources_audit" BEFORE INSERT OR UPDATE ON "public"."calendar_sources" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "event_types_audit" BEFORE INSERT OR UPDATE ON "public"."event_types" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "game_attendance_audit" BEFORE INSERT OR UPDATE ON "public"."game_attendance" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "game_events_audit" BEFORE INSERT OR UPDATE ON "public"."game_events" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "game_lineup_groups_audit" BEFORE INSERT OR UPDATE ON "public"."game_lineup_groups" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "game_lineups_audit" BEFORE INSERT OR UPDATE ON "public"."game_lineups" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "games_audit" BEFORE INSERT OR UPDATE ON "public"."games" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "games_delete_league_pair" AFTER DELETE ON "public"."games" FOR EACH ROW EXECUTE FUNCTION "public"."sync_game_league_pair"();



CREATE OR REPLACE TRIGGER "games_resolve_opponent_team" BEFORE INSERT OR UPDATE ON "public"."games" FOR EACH ROW EXECUTE FUNCTION "public"."resolve_game_opponent_team"();



CREATE OR REPLACE TRIGGER "games_sync_league_pair" AFTER INSERT OR UPDATE ON "public"."games" FOR EACH ROW EXECUTE FUNCTION "public"."sync_game_league_pair"();



CREATE OR REPLACE TRIGGER "jam_sync_conflicts_audit" BEFORE INSERT OR UPDATE ON "public"."jam_sync_conflicts" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "league_games_audit" BEFORE INSERT OR UPDATE ON "public"."league_games" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "league_teams_audit" BEFORE INSERT OR UPDATE ON "public"."league_teams" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "lineup_templates_audit" BEFORE INSERT OR UPDATE ON "public"."lineup_templates" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "organizations_audit" BEFORE INSERT OR UPDATE ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "players_audit" BEFORE INSERT OR UPDATE ON "public"."players" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "season_players_audit" BEFORE INSERT OR UPDATE ON "public"."season_players" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "seasons_audit" BEFORE INSERT OR UPDATE ON "public"."seasons" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_arrows_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_arrows" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_arrows_touch_play" AFTER INSERT OR DELETE OR UPDATE ON "public"."strategy_arrows" FOR EACH ROW EXECUTE FUNCTION "public"."touch_strategy_play"();



CREATE OR REPLACE TRIGGER "strategy_highlights_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_highlights" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_highlights_touch_play" AFTER INSERT OR DELETE OR UPDATE ON "public"."strategy_highlights" FOR EACH ROW EXECUTE FUNCTION "public"."touch_strategy_play"();



CREATE OR REPLACE TRIGGER "strategy_lines_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_lines" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_lines_touch_play" AFTER INSERT OR DELETE OR UPDATE ON "public"."strategy_lines" FOR EACH ROW EXECUTE FUNCTION "public"."touch_strategy_play"();



CREATE OR REPLACE TRIGGER "strategy_opponent_markers_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_opponent_markers" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_opponent_markers_touch_play" AFTER INSERT OR DELETE OR UPDATE ON "public"."strategy_opponent_markers" FOR EACH ROW EXECUTE FUNCTION "public"."touch_strategy_play"();



CREATE OR REPLACE TRIGGER "strategy_plays_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_plays" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_positions_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_positions" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_positions_touch_play" AFTER INSERT OR DELETE OR UPDATE ON "public"."strategy_positions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_strategy_play"();



CREATE OR REPLACE TRIGGER "strategy_steps_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_steps" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_steps_touch_play" AFTER INSERT OR DELETE OR UPDATE ON "public"."strategy_steps" FOR EACH ROW EXECUTE FUNCTION "public"."touch_strategy_play"();



CREATE OR REPLACE TRIGGER "strategy_text_boxes_audit" BEFORE INSERT OR UPDATE ON "public"."strategy_text_boxes" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



CREATE OR REPLACE TRIGGER "strategy_text_boxes_touch_play" AFTER INSERT OR DELETE OR UPDATE ON "public"."strategy_text_boxes" FOR EACH ROW EXECUTE FUNCTION "public"."touch_strategy_play"();



CREATE OR REPLACE TRIGGER "teams_audit" BEFORE INSERT OR UPDATE ON "public"."teams" FOR EACH ROW EXECUTE FUNCTION "public"."set_audit_fields"();



ALTER TABLE ONLY "public"."calendar_sources"
    ADD CONSTRAINT "calendar_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_logs"
    ADD CONSTRAINT "chat_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_attendance"
    ADD CONSTRAINT "game_attendance_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_attendance"
    ADD CONSTRAINT "game_attendance_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_attendance"
    ADD CONSTRAINT "game_attendance_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_events"
    ADD CONSTRAINT "game_events_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_events"
    ADD CONSTRAINT "game_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_events"
    ADD CONSTRAINT "game_events_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."game_events"
    ADD CONSTRAINT "game_events_related_player_id_fkey" FOREIGN KEY ("related_player_id") REFERENCES "public"."players"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."game_lineup_groups"
    ADD CONSTRAINT "game_lineup_groups_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_lineup_groups"
    ADD CONSTRAINT "game_lineup_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_lineups"
    ADD CONSTRAINT "game_lineups_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_lineups"
    ADD CONSTRAINT "game_lineups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_lineups"
    ADD CONSTRAINT "game_lineups_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_opponent_team_id_fkey" FOREIGN KEY ("opponent_team_id") REFERENCES "public"."league_teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id");



ALTER TABLE ONLY "public"."jam_sync_conflicts"
    ADD CONSTRAINT "jam_sync_conflicts_existing_game_id_fkey" FOREIGN KEY ("existing_game_id") REFERENCES "public"."games"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jam_sync_conflicts"
    ADD CONSTRAINT "jam_sync_conflicts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_away_team_id_fkey" FOREIGN KEY ("away_team_id") REFERENCES "public"."league_teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_home_team_id_fkey" FOREIGN KEY ("home_team_id") REFERENCES "public"."league_teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_next_game_id_fkey" FOREIGN KEY ("next_game_id") REFERENCES "public"."league_games"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_our_game_id_fkey" FOREIGN KEY ("our_game_id") REFERENCES "public"."games"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."league_games"
    ADD CONSTRAINT "league_games_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."league_teams"
    ADD CONSTRAINT "league_teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."league_teams"
    ADD CONSTRAINT "league_teams_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lineup_template_groups"
    ADD CONSTRAINT "lineup_template_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lineup_template_groups"
    ADD CONSTRAINT "lineup_template_groups_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."lineup_templates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lineup_template_players"
    ADD CONSTRAINT "lineup_template_players_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lineup_template_players"
    ADD CONSTRAINT "lineup_template_players_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lineup_template_players"
    ADD CONSTRAINT "lineup_template_players_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."lineup_templates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lineup_templates"
    ADD CONSTRAINT "lineup_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lineup_templates"
    ADD CONSTRAINT "lineup_templates_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."players"
    ADD CONSTRAINT "players_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."season_players"
    ADD CONSTRAINT "season_players_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."season_players"
    ADD CONSTRAINT "season_players_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."season_players"
    ADD CONSTRAINT "season_players_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id");



ALTER TABLE ONLY "public"."seasons"
    ADD CONSTRAINT "seasons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."seasons"
    ADD CONSTRAINT "seasons_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id");



ALTER TABLE ONLY "public"."standings"
    ADD CONSTRAINT "standings_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id");



ALTER TABLE ONLY "public"."strategy_arrows"
    ADD CONSTRAINT "strategy_arrows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_arrows"
    ADD CONSTRAINT "strategy_arrows_start_opponent_id_fkey" FOREIGN KEY ("start_opponent_id") REFERENCES "public"."strategy_opponent_markers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."strategy_arrows"
    ADD CONSTRAINT "strategy_arrows_start_player_id_fkey" FOREIGN KEY ("start_player_id") REFERENCES "public"."players"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."strategy_arrows"
    ADD CONSTRAINT "strategy_arrows_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."strategy_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_highlights"
    ADD CONSTRAINT "strategy_highlights_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_highlights"
    ADD CONSTRAINT "strategy_highlights_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."strategy_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_lines"
    ADD CONSTRAINT "strategy_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_lines"
    ADD CONSTRAINT "strategy_lines_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."strategy_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_opponent_markers"
    ADD CONSTRAINT "strategy_opponent_markers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_opponent_markers"
    ADD CONSTRAINT "strategy_opponent_markers_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."strategy_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_plays"
    ADD CONSTRAINT "strategy_plays_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."strategy_plays"
    ADD CONSTRAINT "strategy_plays_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_positions"
    ADD CONSTRAINT "strategy_positions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_positions"
    ADD CONSTRAINT "strategy_positions_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_positions"
    ADD CONSTRAINT "strategy_positions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."strategy_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_steps"
    ADD CONSTRAINT "strategy_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_steps"
    ADD CONSTRAINT "strategy_steps_play_id_fkey" FOREIGN KEY ("play_id") REFERENCES "public"."strategy_plays"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_text_boxes"
    ADD CONSTRAINT "strategy_text_boxes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_text_boxes"
    ADD CONSTRAINT "strategy_text_boxes_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."strategy_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



CREATE POLICY "any signed-in insert" ON "public"."organizations" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated delete" ON "public"."calendar_sources" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."chat_logs" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."game_attendance" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."game_events" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."game_lineup_groups" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."game_lineups" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."games" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."jam_sync_conflicts" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."league_games" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."league_teams" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."lineup_template_groups" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."lineup_template_players" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."lineup_templates" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."players" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."season_players" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."seasons" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_arrows" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_highlights" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_lines" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_opponent_markers" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_plays" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_positions" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_steps" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."strategy_text_boxes" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated delete" ON "public"."teams" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "authenticated insert" ON "public"."calendar_sources" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."chat_logs" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."game_attendance" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."game_events" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."game_lineup_groups" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."game_lineups" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."games" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."jam_sync_conflicts" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."league_games" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."league_teams" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."lineup_template_groups" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."lineup_template_players" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."lineup_templates" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."players" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."season_players" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."seasons" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_arrows" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_highlights" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_lines" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_opponent_markers" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_plays" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_positions" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_steps" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."strategy_text_boxes" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated insert" ON "public"."teams" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "authenticated read" ON "public"."calendar_sources" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."chat_logs" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."event_types" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."game_attendance" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."game_events" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."game_lineup_groups" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."game_lineups" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."games" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."jam_sync_conflicts" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."league_games" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."league_teams" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."lineup_template_groups" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."lineup_template_players" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."lineup_templates" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."organizations" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."players" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."season_players" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."seasons" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."standings" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_arrows" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_highlights" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_lines" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_opponent_markers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_plays" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_positions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_steps" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."strategy_text_boxes" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."teams" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated update" ON "public"."calendar_sources" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."chat_logs" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."game_attendance" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."game_events" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."game_lineup_groups" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."game_lineups" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."games" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."jam_sync_conflicts" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."league_games" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."league_teams" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."lineup_template_groups" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."lineup_template_players" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."lineup_templates" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."players" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."season_players" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."seasons" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_arrows" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_highlights" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_lines" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_opponent_markers" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_plays" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_positions" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_steps" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."strategy_text_boxes" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "authenticated update" ON "public"."teams" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."calendar_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_types" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_attendance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_lineup_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_lineups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."games" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jam_sync_conflicts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."league_games" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."league_teams" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lineup_template_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lineup_template_players" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lineup_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "member read" ON "public"."organization_members" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_org_member"("organization_members"."organization_id") AS "is_org_member"));



CREATE POLICY "org member delete" ON "public"."event_types" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE ("organization_members"."email" = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text"))))));



CREATE POLICY "org member insert" ON "public"."event_types" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE ("organization_members"."email" = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text"))))));



CREATE POLICY "org member update" ON "public"."event_types" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE ("organization_members"."email" = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE ("organization_members"."email" = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text"))))));



ALTER TABLE "public"."organization_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner delete" ON "public"."organizations" FOR DELETE TO "authenticated" USING (( SELECT "public"."is_org_owner"("organizations"."id") AS "is_org_owner"));



CREATE POLICY "owner invite or self join" ON "public"."organization_members" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "public"."is_org_owner"("organization_members"."organization_id") AS "is_org_owner") OR ("email" = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text")))));



CREATE POLICY "owner remove or self leave" ON "public"."organization_members" FOR DELETE TO "authenticated" USING ((( SELECT "public"."is_org_owner"("organization_members"."organization_id") AS "is_org_owner") OR ("email" = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text")))));



CREATE POLICY "owner update" ON "public"."organizations" FOR UPDATE TO "authenticated" USING (( SELECT "public"."is_org_owner"("organizations"."id") AS "is_org_owner")) WITH CHECK (( SELECT "public"."is_org_owner"("organizations"."id") AS "is_org_owner"));



CREATE POLICY "owner update role" ON "public"."organization_members" FOR UPDATE TO "authenticated" USING (( SELECT "public"."is_org_owner"("organization_members"."organization_id") AS "is_org_owner")) WITH CHECK (( SELECT "public"."is_org_owner"("organization_members"."organization_id") AS "is_org_owner"));



ALTER TABLE "public"."players" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."season_players" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."seasons" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."standings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_arrows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_highlights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_opponent_markers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_plays" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_positions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_steps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_text_boxes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."teams" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."get_secret"("secret_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_secret"("secret_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_org_member"("org_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_org_member"("org_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_member"("org_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_org_owner"("org_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_org_owner"("org_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_owner"("org_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."my_organizations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_organizations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_organizations"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."org_is_public"("org_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."org_is_public"("org_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."org_is_public"("org_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_game_opponent_team"() TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_game_opponent_team"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_game_opponent_team"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_audit_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_audit_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_audit_fields"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_game_league_pair"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_game_league_pair"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_game_league_pair"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_strategy_play"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_strategy_play"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_strategy_play"() TO "service_role";


















GRANT ALL ON TABLE "public"."calendar_sources" TO "anon";
GRANT ALL ON TABLE "public"."calendar_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_sources" TO "service_role";



GRANT ALL ON SEQUENCE "public"."calendar_sources_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."calendar_sources_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."calendar_sources_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."chat_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."chat_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."chat_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."chat_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."event_types" TO "authenticated";
GRANT ALL ON TABLE "public"."event_types" TO "service_role";



GRANT ALL ON SEQUENCE "public"."event_types_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."event_types_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."event_types_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."game_attendance" TO "authenticated";
GRANT ALL ON TABLE "public"."game_attendance" TO "service_role";



GRANT ALL ON SEQUENCE "public"."game_attendance_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."game_attendance_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."game_attendance_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."game_events" TO "authenticated";
GRANT ALL ON TABLE "public"."game_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."game_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."game_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."game_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."game_lineup_groups" TO "anon";
GRANT ALL ON TABLE "public"."game_lineup_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."game_lineup_groups" TO "service_role";



GRANT ALL ON SEQUENCE "public"."game_lineup_groups_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."game_lineup_groups_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."game_lineup_groups_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."game_lineups" TO "authenticated";
GRANT ALL ON TABLE "public"."game_lineups" TO "service_role";



GRANT ALL ON SEQUENCE "public"."game_lineups_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."game_lineups_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."game_lineups_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."games" TO "authenticated";
GRANT ALL ON TABLE "public"."games" TO "service_role";



GRANT ALL ON SEQUENCE "public"."games_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."games_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."games_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."jam_sync_conflicts" TO "anon";
GRANT ALL ON TABLE "public"."jam_sync_conflicts" TO "authenticated";
GRANT ALL ON TABLE "public"."jam_sync_conflicts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."jam_sync_conflicts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."jam_sync_conflicts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."jam_sync_conflicts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."league_games" TO "anon";
GRANT ALL ON TABLE "public"."league_games" TO "authenticated";
GRANT ALL ON TABLE "public"."league_games" TO "service_role";



GRANT ALL ON SEQUENCE "public"."league_games_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."league_games_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."league_games_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."league_teams" TO "anon";
GRANT ALL ON TABLE "public"."league_teams" TO "authenticated";
GRANT ALL ON TABLE "public"."league_teams" TO "service_role";



GRANT ALL ON SEQUENCE "public"."league_teams_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."league_teams_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."league_teams_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lineup_template_groups" TO "anon";
GRANT ALL ON TABLE "public"."lineup_template_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."lineup_template_groups" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lineup_template_groups_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lineup_template_groups_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lineup_template_groups_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lineup_template_players" TO "anon";
GRANT ALL ON TABLE "public"."lineup_template_players" TO "authenticated";
GRANT ALL ON TABLE "public"."lineup_template_players" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lineup_template_players_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lineup_template_players_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lineup_template_players_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lineup_templates" TO "anon";
GRANT ALL ON TABLE "public"."lineup_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."lineup_templates" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lineup_templates_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lineup_templates_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lineup_templates_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."organization_members" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_members" TO "service_role";



GRANT ALL ON SEQUENCE "public"."organization_members_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."organization_members_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."organization_members_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."organizations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."organizations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."organizations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."players" TO "authenticated";
GRANT ALL ON TABLE "public"."players" TO "service_role";



GRANT ALL ON SEQUENCE "public"."players_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."players_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."players_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."season_players" TO "authenticated";
GRANT ALL ON TABLE "public"."season_players" TO "service_role";



GRANT ALL ON SEQUENCE "public"."season_players_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."season_players_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."season_players_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."seasons" TO "authenticated";
GRANT ALL ON TABLE "public"."seasons" TO "service_role";



GRANT ALL ON SEQUENCE "public"."seasons_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."seasons_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."seasons_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."standings" TO "authenticated";
GRANT ALL ON TABLE "public"."standings" TO "service_role";



GRANT ALL ON SEQUENCE "public"."standings_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."standings_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."standings_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_arrows" TO "anon";
GRANT ALL ON TABLE "public"."strategy_arrows" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_arrows" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_arrows_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_arrows_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_arrows_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_highlights" TO "anon";
GRANT ALL ON TABLE "public"."strategy_highlights" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_highlights" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_highlights_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_highlights_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_highlights_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_lines" TO "anon";
GRANT ALL ON TABLE "public"."strategy_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_lines" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_lines_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_lines_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_lines_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_opponent_markers" TO "anon";
GRANT ALL ON TABLE "public"."strategy_opponent_markers" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_opponent_markers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_opponent_markers_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_opponent_markers_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_opponent_markers_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_plays" TO "anon";
GRANT ALL ON TABLE "public"."strategy_plays" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_plays" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_plays_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_plays_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_plays_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_positions" TO "anon";
GRANT ALL ON TABLE "public"."strategy_positions" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_positions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_positions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_positions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_positions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_steps" TO "anon";
GRANT ALL ON TABLE "public"."strategy_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_steps" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_steps_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_steps_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_steps_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_text_boxes" TO "anon";
GRANT ALL ON TABLE "public"."strategy_text_boxes" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_text_boxes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_text_boxes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_text_boxes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_text_boxes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."teams" TO "authenticated";
GRANT ALL ON TABLE "public"."teams" TO "service_role";



GRANT ALL ON SEQUENCE "public"."teams_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."teams_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."teams_id_seq" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































