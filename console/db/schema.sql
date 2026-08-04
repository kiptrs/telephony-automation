\restrict dbmate

-- Dumped from database version 17.10
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    phone_number_id uuid,
    attempt integer DEFAULT 1 NOT NULL,
    telnyx_call_control_id text,
    status text DEFAULT 'queued'::text NOT NULL,
    outcome text,
    last_step integer,
    hangup_cause text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dialed_at timestamp with time zone,
    answered_at timestamp with time zone,
    ended_at timestamp with time zone,
    CONSTRAINT calls_outcome_valid CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['completed'::text, 'abandoned'::text, 'no_answer'::text, 'busy'::text, 'failed'::text, 'unknown'::text])))),
    CONSTRAINT calls_status_valid CHECK ((status = ANY (ARRAY['queued'::text, 'dialing'::text, 'in_progress'::text, 'ended'::text, 'failed'::text])))
);


--
-- Name: campaign_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    "position" integer NOT NULL,
    s3_key text NOT NULL,
    original_filename text NOT NULL,
    bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_questions_position_valid CHECK ((("position" >= 1) AND ("position" <= 10)))
);


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    language text NOT NULL,
    default_country character(2) NOT NULL,
    silence_ms integer DEFAULT 2500 NOT NULL,
    thanks_s3_key text,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    launched_at timestamp with time zone,
    CONSTRAINT campaigns_silence_ms_valid CHECK (((silence_ms >= 500) AND (silence_ms <= 10000))),
    CONSTRAINT campaigns_status_valid CHECK ((status = ANY (ARRAY['draft'::text, 'running'::text, 'paused'::text, 'completed'::text])))
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    e164 text NOT NULL,
    external_ref text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contacts_e164_format CHECK ((e164 ~ '^\+[1-9][0-9]{6,14}$'::text)),
    CONSTRAINT contacts_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'dialing'::text, 'done'::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    CONSTRAINT jobs_kind_valid CHECK ((kind = ANY (ARRAY['ingest_recording'::text, 'transcribe'::text])))
);


--
-- Name: number_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.number_leases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_number_id uuid NOT NULL,
    call_id uuid,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    released_at timestamp with time zone
);


--
-- Name: phone_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_numbers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    e164 text NOT NULL,
    telnyx_number_id text,
    tenant_id uuid,
    max_concurrent integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT phone_numbers_e164_format CHECK ((e164 ~ '^\+[1-9][0-9]{6,14}$'::text)),
    CONSTRAINT phone_numbers_max_concurrent_valid CHECK ((max_concurrent >= 1)),
    CONSTRAINT phone_numbers_status_valid CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'released'::text])))
);


--
-- Name: recordings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_id uuid NOT NULL,
    telnyx_recording_id text NOT NULL,
    source_url text,
    channels text,
    s3_key text,
    bytes bigint,
    duration_ms integer,
    ingested_at timestamp with time zone,
    telnyx_deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recording_id uuid NOT NULL,
    engine text NOT NULL,
    language text,
    text text,
    raw_s3_key text,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT transcripts_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    email public.citext NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_role_valid CHECK ((role = ANY (ARRAY['platform_admin'::text, 'member'::text]))),
    CONSTRAINT users_tenant_matches_role CHECK ((((role = 'platform_admin'::text) AND (tenant_id IS NULL)) OR ((role = 'member'::text) AND (tenant_id IS NOT NULL))))
);


--
-- Name: calls calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_pkey PRIMARY KEY (id);


--
-- Name: calls calls_telnyx_call_control_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_telnyx_call_control_id_key UNIQUE (telnyx_call_control_id);


--
-- Name: campaign_questions campaign_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_questions
    ADD CONSTRAINT campaign_questions_pkey PRIMARY KEY (id);


--
-- Name: campaign_questions campaign_questions_position_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_questions
    ADD CONSTRAINT campaign_questions_position_unique UNIQUE (campaign_id, "position") DEFERRABLE;


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_unique_per_campaign; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_unique_per_campaign UNIQUE (campaign_id, e164);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: number_leases number_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_leases
    ADD CONSTRAINT number_leases_pkey PRIMARY KEY (id);


--
-- Name: phone_numbers phone_numbers_e164_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_e164_key UNIQUE (e164);


--
-- Name: phone_numbers phone_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_pkey PRIMARY KEY (id);


--
-- Name: recordings recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_pkey PRIMARY KEY (id);


--
-- Name: recordings recordings_telnyx_recording_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_telnyx_recording_id_key UNIQUE (telnyx_recording_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: transcripts transcripts_one_per_recording; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_one_per_recording UNIQUE (recording_id);


--
-- Name: transcripts transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: calls_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calls_campaign_idx ON public.calls USING btree (campaign_id, created_at DESC);


--
-- Name: calls_ccid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calls_ccid_idx ON public.calls USING btree (telnyx_call_control_id) WHERE (telnyx_call_control_id IS NOT NULL);


--
-- Name: calls_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calls_contact_idx ON public.calls USING btree (contact_id);


--
-- Name: campaign_questions_campaign_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_questions_campaign_id_idx ON public.campaign_questions USING btree (campaign_id, "position");


--
-- Name: campaigns_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_tenant_id_idx ON public.campaigns USING btree (tenant_id, created_at DESC);


--
-- Name: contacts_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_pending_idx ON public.contacts USING btree (campaign_id, created_at) WHERE (status = 'pending'::text);


--
-- Name: jobs_claimable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_claimable_idx ON public.jobs USING btree (run_at) WHERE ((completed_at IS NULL) AND (failed_at IS NULL));


--
-- Name: number_leases_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX number_leases_active_idx ON public.number_leases USING btree (phone_number_id) WHERE (released_at IS NULL);


--
-- Name: number_leases_call_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX number_leases_call_id_idx ON public.number_leases USING btree (call_id);


--
-- Name: phone_numbers_available_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX phone_numbers_available_idx ON public.phone_numbers USING btree (last_used_at NULLS FIRST) WHERE (status = 'active'::text);


--
-- Name: recordings_call_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recordings_call_idx ON public.recordings USING btree (call_id);


--
-- Name: recordings_ingested_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recordings_ingested_idx ON public.recordings USING btree (ingested_at) WHERE (ingested_at IS NOT NULL);


--
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


--
-- Name: users_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_tenant_id_idx ON public.users USING btree (tenant_id);


--
-- Name: calls calls_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: calls calls_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: calls calls_phone_number_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES public.phone_numbers(id) ON DELETE SET NULL;


--
-- Name: campaign_questions campaign_questions_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_questions
    ADD CONSTRAINT campaign_questions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: number_leases number_leases_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_leases
    ADD CONSTRAINT number_leases_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.calls(id) ON DELETE SET NULL;


--
-- Name: number_leases number_leases_phone_number_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_leases
    ADD CONSTRAINT number_leases_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES public.phone_numbers(id) ON DELETE CASCADE;


--
-- Name: phone_numbers phone_numbers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: recordings recordings_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.calls(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: transcripts transcripts_recording_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE CASCADE;


--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260804090000'),
    ('20260804090100'),
    ('20260804090200'),
    ('20260804090300'),
    ('20260805090000'),
    ('20260805090100'),
    ('20260806090000'),
    ('20260806090100');
