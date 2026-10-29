


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


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."applications" (
    "id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "find_id" "text",
    "company" "text",
    "role" "text",
    "stage" "text" DEFAULT 'applied'::"text" NOT NULL,
    "applied_at" timestamp with time zone,
    "stage_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_activity_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."applications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."candidates" (
    "email" "text" NOT NULL,
    "dossier" "jsonb" NOT NULL,
    "email_config" "jsonb" DEFAULT '{}'::"jsonb",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."company_req_snapshots" (
    "date" "date" NOT NULL,
    "company" "text" NOT NULL,
    "open_count" integer NOT NULL
);


ALTER TABLE "public"."company_req_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_events" (
    "id" bigint NOT NULL,
    "ts" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" "text" NOT NULL,
    "type" "text" NOT NULL,
    "channel" "text" DEFAULT 'state'::"text" NOT NULL,
    "campaign" "text",
    "find_id" "text",
    "resend_id" "text",
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."email_events" OWNER TO "postgres";


ALTER TABLE "public"."email_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."email_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."finds" (
    "id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "job" "jsonb" NOT NULL,
    "match" "jsonb" NOT NULL,
    "composed" "jsonb",
    "status" "text" DEFAULT 'new'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."finds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."referral_lookups" (
    "id" bigint NOT NULL,
    "email" "text" NOT NULL,
    "domain" "text" NOT NULL,
    "company" "text",
    "contacts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "chosen" "jsonb",
    "provider" "text" DEFAULT 'hunter'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."referral_lookups" OWNER TO "postgres";


ALTER TABLE "public"."referral_lookups" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."referral_lookups_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scheduled_tasks" (
    "id" bigint NOT NULL,
    "email" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "run_at" timestamp with time zone NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "done_at" timestamp with time zone
);


ALTER TABLE "public"."scheduled_tasks" OWNER TO "postgres";


ALTER TABLE "public"."scheduled_tasks" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."scheduled_tasks_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."signals" (
    "id" bigint NOT NULL,
    "email" "text" NOT NULL,
    "find_id" "text",
    "job_id" "text",
    "event" "text" NOT NULL,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."signals" OWNER TO "postgres";


ALTER TABLE "public"."signals" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."signals_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."suppressions" (
    "address" "text" NOT NULL,
    "reason" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."suppressions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."waitlist" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" "text"
);


ALTER TABLE "public"."waitlist" OWNER TO "postgres";


ALTER TABLE "public"."waitlist" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."waitlist_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."applications"
    ADD CONSTRAINT "applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."candidates"
    ADD CONSTRAINT "candidates_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."company_req_snapshots"
    ADD CONSTRAINT "company_req_snapshots_pkey" PRIMARY KEY ("date", "company");



ALTER TABLE ONLY "public"."email_events"
    ADD CONSTRAINT "email_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."finds"
    ADD CONSTRAINT "finds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referral_lookups"
    ADD CONSTRAINT "referral_lookups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scheduled_tasks"
    ADD CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppressions"
    ADD CONSTRAINT "suppressions_pkey" PRIMARY KEY ("address");



ALTER TABLE ONLY "public"."waitlist"
    ADD CONSTRAINT "waitlist_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."waitlist"
    ADD CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id");



CREATE INDEX "applications_email_idx" ON "public"."applications" USING "btree" ("email", "stage");



CREATE INDEX "company_req_snapshots_company_date_idx" ON "public"."company_req_snapshots" USING "btree" ("company", "date" DESC);



CREATE INDEX "idx_ee_email_ts" ON "public"."email_events" USING "btree" ("email", "ts" DESC);



CREATE INDEX "idx_ee_find" ON "public"."email_events" USING "btree" ("find_id");



CREATE INDEX "idx_ee_resend" ON "public"."email_events" USING "btree" ("resend_id");



CREATE INDEX "idx_ee_type_ts" ON "public"."email_events" USING "btree" ("type", "ts" DESC);



CREATE INDEX "idx_finds_email" ON "public"."finds" USING "btree" ("email");



CREATE INDEX "idx_finds_email_status" ON "public"."finds" USING "btree" ("email", "status");



CREATE INDEX "idx_signals_email" ON "public"."signals" USING "btree" ("email");



CREATE INDEX "idx_signals_find_event" ON "public"."signals" USING "btree" ("find_id", "event");



CREATE INDEX "referral_lookups_created_idx" ON "public"."referral_lookups" USING "btree" ("created_at" DESC);



CREATE INDEX "referral_lookups_domain_idx" ON "public"."referral_lookups" USING "btree" ("domain", "created_at" DESC);



CREATE INDEX "scheduled_tasks_due_idx" ON "public"."scheduled_tasks" USING "btree" ("status", "run_at");



CREATE INDEX "scheduled_tasks_email_idx" ON "public"."scheduled_tasks" USING "btree" ("email", "kind", "status");



ALTER TABLE ONLY "public"."finds"
    ADD CONSTRAINT "finds_email_fkey" FOREIGN KEY ("email") REFERENCES "public"."candidates"("email");



CREATE POLICY "anon can join waitlist" ON "public"."waitlist" FOR INSERT TO "anon" WITH CHECK (true);



ALTER TABLE "public"."applications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."company_req_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."finds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."referral_lookups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scheduled_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."suppressions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."waitlist" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON TABLE "public"."applications" TO "anon";
GRANT ALL ON TABLE "public"."applications" TO "authenticated";
GRANT ALL ON TABLE "public"."applications" TO "service_role";



GRANT ALL ON TABLE "public"."candidates" TO "anon";
GRANT ALL ON TABLE "public"."candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."candidates" TO "service_role";



GRANT ALL ON TABLE "public"."company_req_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."company_req_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."company_req_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."email_events" TO "anon";
GRANT ALL ON TABLE "public"."email_events" TO "authenticated";
GRANT ALL ON TABLE "public"."email_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."email_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."email_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."email_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."finds" TO "anon";
GRANT ALL ON TABLE "public"."finds" TO "authenticated";
GRANT ALL ON TABLE "public"."finds" TO "service_role";



GRANT ALL ON TABLE "public"."referral_lookups" TO "anon";
GRANT ALL ON TABLE "public"."referral_lookups" TO "authenticated";
GRANT ALL ON TABLE "public"."referral_lookups" TO "service_role";



GRANT ALL ON SEQUENCE "public"."referral_lookups_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."referral_lookups_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."referral_lookups_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."scheduled_tasks" TO "anon";
GRANT ALL ON TABLE "public"."scheduled_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."scheduled_tasks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."scheduled_tasks_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."scheduled_tasks_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."scheduled_tasks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."signals" TO "anon";
GRANT ALL ON TABLE "public"."signals" TO "authenticated";
GRANT ALL ON TABLE "public"."signals" TO "service_role";



GRANT ALL ON SEQUENCE "public"."signals_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."signals_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."signals_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."suppressions" TO "anon";
GRANT ALL ON TABLE "public"."suppressions" TO "authenticated";
GRANT ALL ON TABLE "public"."suppressions" TO "service_role";



GRANT ALL ON TABLE "public"."waitlist" TO "anon";
GRANT ALL ON TABLE "public"."waitlist" TO "authenticated";
GRANT ALL ON TABLE "public"."waitlist" TO "service_role";



GRANT ALL ON SEQUENCE "public"."waitlist_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."waitlist_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."waitlist_id_seq" TO "service_role";



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







