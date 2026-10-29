export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      applications: {
        Row: {
          applied_at: string | null
          company: string | null
          created_at: string
          email: string
          find_id: string | null
          id: string
          last_activity_at: string
          meta: Json
          role: string | null
          stage: string
          stage_at: string
          updated_at: string
        }
        Insert: {
          applied_at?: string | null
          company?: string | null
          created_at?: string
          email: string
          find_id?: string | null
          id: string
          last_activity_at?: string
          meta?: Json
          role?: string | null
          stage?: string
          stage_at?: string
          updated_at?: string
        }
        Update: {
          applied_at?: string | null
          company?: string | null
          created_at?: string
          email?: string
          find_id?: string | null
          id?: string
          last_activity_at?: string
          meta?: Json
          role?: string | null
          stage?: string
          stage_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      candidates: {
        Row: {
          created_at: string | null
          dossier: Json
          email: string
          email_config: Json | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          dossier: Json
          email: string
          email_config?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          dossier?: Json
          email?: string
          email_config?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      company_req_snapshots: {
        Row: {
          company: string
          date: string
          open_count: number
        }
        Insert: {
          company: string
          date: string
          open_count: number
        }
        Update: {
          company?: string
          date?: string
          open_count?: number
        }
        Relationships: []
      }
      email_events: {
        Row: {
          campaign: string | null
          channel: string
          created_at: string
          email: string
          find_id: string | null
          id: number
          meta: Json
          resend_id: string | null
          ts: string
          type: string
        }
        Insert: {
          campaign?: string | null
          channel?: string
          created_at?: string
          email: string
          find_id?: string | null
          id?: never
          meta?: Json
          resend_id?: string | null
          ts?: string
          type: string
        }
        Update: {
          campaign?: string | null
          channel?: string
          created_at?: string
          email?: string
          find_id?: string | null
          id?: never
          meta?: Json
          resend_id?: string | null
          ts?: string
          type?: string
        }
        Relationships: []
      }
      finds: {
        Row: {
          composed: Json | null
          created_at: string | null
          email: string
          id: string
          job: Json
          match: Json
          matcher_version: string | null
          sent_variant: string | null
          slot: number | null
          status: string | null
        }
        Insert: {
          composed?: Json | null
          created_at?: string | null
          email: string
          id: string
          job: Json
          match: Json
          matcher_version?: string | null
          sent_variant?: string | null
          slot?: number | null
          status?: string | null
        }
        Update: {
          composed?: Json | null
          created_at?: string | null
          email?: string
          id?: string
          job?: Json
          match?: Json
          matcher_version?: string | null
          sent_variant?: string | null
          slot?: number | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finds_email_fkey"
            columns: ["email"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["email"]
          },
        ]
      }
      friend_referrals: {
        Row: {
          created_at: string
          friend_email: string | null
          giver_email: string
          id: number
          job_id: string | null
          kind: string
          ref_code: string | null
          variant: string | null
        }
        Insert: {
          created_at?: string
          friend_email?: string | null
          giver_email: string
          id?: never
          job_id?: string | null
          kind: string
          ref_code?: string | null
          variant?: string | null
        }
        Update: {
          created_at?: string
          friend_email?: string | null
          giver_email?: string
          id?: never
          job_id?: string | null
          kind?: string
          ref_code?: string | null
          variant?: string | null
        }
        Relationships: []
      }
      hire_agent_drafts: {
        Row: {
          agent: string
          body_text: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          email: string
          id: string
          kind: string
          mandate: string
          name: string | null
          reason: string
          result: string | null
          run_id: string | null
          send: Json
          status: string
          subject: string
        }
        Insert: {
          agent: string
          body_text: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email: string
          id?: string
          kind: string
          mandate: string
          name?: string | null
          reason: string
          result?: string | null
          run_id?: string | null
          send: Json
          status?: string
          subject: string
        }
        Update: {
          agent?: string
          body_text?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email?: string
          id?: string
          kind?: string
          mandate?: string
          name?: string | null
          reason?: string
          result?: string | null
          run_id?: string | null
          send?: Json
          status?: string
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "hire_agent_drafts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "hire_agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_agent_runs: {
        Row: {
          agent: string
          counts: Json
          error: string | null
          finished_at: string | null
          id: string
          items: Json
          mode: string
          note: string | null
          started_at: string
          status: string
          trigger: string
        }
        Insert: {
          agent: string
          counts?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          items?: Json
          mode: string
          note?: string | null
          started_at?: string
          status?: string
          trigger: string
        }
        Update: {
          agent?: string
          counts?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          items?: Json
          mode?: string
          note?: string | null
          started_at?: string
          status?: string
          trigger?: string
        }
        Relationships: []
      }
      hire_agents: {
        Row: {
          enabled: boolean
          id: string
          mode: string
          settings: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          id: string
          mode: string
          settings?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          id?: string
          mode?: string
          settings?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      hire_candidacy_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          approval_id: string | null
          at: string
          candidate_id: string | null
          from_stage: string | null
          id: string
          job_id: string
          org_id: string
          reason: string | null
          ref: string | null
          thread_id: string | null
          to_stage: string | null
          type: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          approval_id?: string | null
          at?: string
          candidate_id?: string | null
          from_stage?: string | null
          id?: string
          job_id: string
          org_id?: string
          reason?: string | null
          ref?: string | null
          thread_id?: string | null
          to_stage?: string | null
          type: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          approval_id?: string | null
          at?: string
          candidate_id?: string | null
          from_stage?: string | null
          id?: string
          job_id?: string
          org_id?: string
          reason?: string | null
          ref?: string | null
          thread_id?: string | null
          to_stage?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "hire_candidacy_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "hire_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_candidacy_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "hire_orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_candidacy_events_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "hire_qualify_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_candidacy_proposals: {
        Row: {
          check_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          evidence: Json
          id: string
          job_id: string
          kind: string
          org_id: string
          proposed_by: string
          reason: string
          status: string
          thread_id: string
        }
        Insert: {
          check_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          evidence?: Json
          id?: string
          job_id: string
          kind: string
          org_id?: string
          proposed_by: string
          reason: string
          status?: string
          thread_id: string
        }
        Update: {
          check_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          evidence?: Json
          id?: string
          job_id?: string
          kind?: string
          org_id?: string
          proposed_by?: string
          reason?: string
          status?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hire_candidacy_proposals_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "hire_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_candidacy_proposals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "hire_orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_candidacy_proposals_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "hire_qualify_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_connection_roles: {
        Row: {
          connection_id: string
          external_id: string
          external_status: string | null
          first_seen_at: string
          id: string
          job_id: string | null
          last_seen_at: string
          payload: Json
          payload_hash: string
        }
        Insert: {
          connection_id: string
          external_id: string
          external_status?: string | null
          first_seen_at?: string
          id?: string
          job_id?: string | null
          last_seen_at?: string
          payload: Json
          payload_hash: string
        }
        Update: {
          connection_id?: string
          external_id?: string
          external_status?: string | null
          first_seen_at?: string
          id?: string
          job_id?: string | null
          last_seen_at?: string
          payload?: Json
          payload_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "hire_connection_roles_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "hire_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_connection_roles_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "hire_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_connections: {
        Row: {
          created_at: string
          destination: Json
          id: string
          key: string
          mode: string
          name: string
          org_id: string
          sequence: Json
          settings: Json
          source: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          destination?: Json
          id?: string
          key: string
          mode?: string
          name: string
          org_id?: string
          sequence?: Json
          settings?: Json
          source?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          destination?: Json
          id?: string
          key?: string
          mode?: string
          name?: string
          org_id?: string
          sequence?: Json
          settings?: Json
          source?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hire_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "hire_orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_jobs: {
        Row: {
          client: string | null
          created_at: string
          id: string
          jd_source: string | null
          jd_text: string
          last_search: Json | null
          lifecycle: string
          org_id: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          client?: string | null
          created_at?: string
          id?: string
          jd_source?: string | null
          jd_text: string
          last_search?: Json | null
          lifecycle?: string
          org_id?: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          client?: string | null
          created_at?: string
          id?: string
          jd_source?: string | null
          jd_text?: string
          last_search?: Json | null
          lifecycle?: string
          org_id?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hire_jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "hire_orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_orgs: {
        Row: {
          created_at: string
          id: string
          kind: string
          name: string
        }
        Insert: {
          created_at?: string
          id: string
          kind?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          name?: string
        }
        Relationships: []
      }
      hire_people: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          linkedin_key: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          linkedin_key?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          linkedin_key?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      hire_pursuit_events: {
        Row: {
          actor: string
          at: string
          effects: Json
          from_state: Json | null
          id: string
          pursuit_id: string
          recorded_at: string
          ref: string | null
          seq: number
          to_state: Json | null
          type: string
          version: string
        }
        Insert: {
          actor: string
          at: string
          effects?: Json
          from_state?: Json | null
          id?: string
          pursuit_id: string
          recorded_at?: string
          ref?: string | null
          seq: number
          to_state?: Json | null
          type: string
          version: string
        }
        Update: {
          actor?: string
          at?: string
          effects?: Json
          from_state?: Json | null
          id?: string
          pursuit_id?: string
          recorded_at?: string
          ref?: string | null
          seq?: number
          to_state?: Json | null
          type?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "hire_pursuit_events_pursuit_id_fkey"
            columns: ["pursuit_id"]
            isOneToOne: false
            referencedRelation: "hire_pursuits"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_pursuit_keys: {
        Row: {
          created_at: string
          key: string
          pursuit_id: string
        }
        Insert: {
          created_at?: string
          key: string
          pursuit_id: string
        }
        Update: {
          created_at?: string
          key?: string
          pursuit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hire_pursuit_keys_pursuit_id_fkey"
            columns: ["pursuit_id"]
            isOneToOne: false
            referencedRelation: "hire_pursuits"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_pursuits: {
        Row: {
          ask: Json | null
          closed_out: boolean
          contact: Json
          created_at: string
          disclosure: Json
          discovery_run: string | null
          due_at: string | null
          employer: string
          engagement: string
          handoff: string
          id: string
          job_id: string
          outreach_type: string
          person_id: string
          screening: Json
          screening_consent: Json
          sent_to: string | null
          seq: number
          source: string
          source_at: string | null
          to_read: Json | null
          updated_at: string
          version: string
          waiting_for: string | null
        }
        Insert: {
          ask?: Json | null
          closed_out?: boolean
          contact: Json
          created_at?: string
          disclosure: Json
          discovery_run?: string | null
          due_at?: string | null
          employer: string
          engagement: string
          handoff: string
          id?: string
          job_id: string
          outreach_type: string
          person_id: string
          screening: Json
          screening_consent: Json
          sent_to?: string | null
          seq?: number
          source: string
          source_at?: string | null
          to_read?: Json | null
          updated_at?: string
          version: string
          waiting_for?: string | null
        }
        Update: {
          ask?: Json | null
          closed_out?: boolean
          contact?: Json
          created_at?: string
          disclosure?: Json
          discovery_run?: string | null
          due_at?: string | null
          employer?: string
          engagement?: string
          handoff?: string
          id?: string
          job_id?: string
          outreach_type?: string
          person_id?: string
          screening?: Json
          screening_consent?: Json
          sent_to?: string | null
          seq?: number
          source?: string
          source_at?: string | null
          to_read?: Json | null
          updated_at?: string
          version?: string
          waiting_for?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hire_pursuits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "hire_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_pursuits_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "hire_people"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_qualify_threads: {
        Row: {
          answers: Json
          candidate_id: string
          close_reason: string | null
          connection_id: string
          consent: Json | null
          created_at: string
          cv_path: string | null
          cv_text: string | null
          email: string
          evaluation: Json | null
          external_role_id: string | null
          fields: Json
          fit: string | null
          id: string
          job_id: string
          last_error: string | null
          name: string | null
          org_id: string
          overrides: Json
          questions: Json
          replied_at: string | null
          reply_key: string
          rounds: number
          stage: string
          updated_at: string
          verify_sent_at: string | null
        }
        Insert: {
          answers?: Json
          candidate_id: string
          close_reason?: string | null
          connection_id: string
          consent?: Json | null
          created_at?: string
          cv_path?: string | null
          cv_text?: string | null
          email: string
          evaluation?: Json | null
          external_role_id?: string | null
          fields?: Json
          fit?: string | null
          id?: string
          job_id: string
          last_error?: string | null
          name?: string | null
          org_id?: string
          overrides?: Json
          questions?: Json
          replied_at?: string | null
          reply_key: string
          rounds?: number
          stage: string
          updated_at?: string
          verify_sent_at?: string | null
        }
        Update: {
          answers?: Json
          candidate_id?: string
          close_reason?: string | null
          connection_id?: string
          consent?: Json | null
          created_at?: string
          cv_path?: string | null
          cv_text?: string | null
          email?: string
          evaluation?: Json | null
          external_role_id?: string | null
          fields?: Json
          fit?: string | null
          id?: string
          job_id?: string
          last_error?: string | null
          name?: string | null
          org_id?: string
          overrides?: Json
          questions?: Json
          replied_at?: string | null
          reply_key?: string
          rounds?: number
          stage?: string
          updated_at?: string
          verify_sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hire_qualify_threads_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "hire_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_qualify_threads_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "hire_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_qualify_threads_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "hire_orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_submissions: {
        Row: {
          attempt: number
          candidate_id: string
          connection_id: string
          created_at: string
          external_role_id: string
          id: string
          job_id: string
          mode: string
          payload: Json
          payload_hash: string
          response: Json | null
          status: string
          thread_id: string | null
        }
        Insert: {
          attempt?: number
          candidate_id: string
          connection_id: string
          created_at?: string
          external_role_id: string
          id?: string
          job_id: string
          mode: string
          payload: Json
          payload_hash: string
          response?: Json | null
          status: string
          thread_id?: string | null
        }
        Update: {
          attempt?: number
          candidate_id?: string
          connection_id?: string
          created_at?: string
          external_role_id?: string
          id?: string
          job_id?: string
          mode?: string
          payload?: Json
          payload_hash?: string
          response?: Json | null
          status?: string
          thread_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hire_submissions_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "hire_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_submissions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "hire_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hire_submissions_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "hire_qualify_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      hire_work: {
        Row: {
          attempts: number
          company: string | null
          created_at: string
          id: string
          key: string
          kind: string
          last_error: string | null
          lease_until: string | null
          leased_by: string | null
          max_attempts: number
          payload: Json
          result: Json | null
          run_after: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          company?: string | null
          created_at?: string
          id?: string
          key: string
          kind: string
          last_error?: string | null
          lease_until?: string | null
          leased_by?: string | null
          max_attempts?: number
          payload?: Json
          result?: Json | null
          run_after?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          company?: string | null
          created_at?: string
          id?: string
          key?: string
          kind?: string
          last_error?: string | null
          lease_until?: string | null
          leased_by?: string | null
          max_attempts?: number
          payload?: Json
          result?: Json | null
          run_after?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      inbound_messages: {
        Row: {
          body: string | null
          email: string
          email_id: string | null
          id: number
          received_at: string
          stage: string | null
          subject: string | null
        }
        Insert: {
          body?: string | null
          email: string
          email_id?: string | null
          id?: number
          received_at?: string
          stage?: string | null
          subject?: string | null
        }
        Update: {
          body?: string | null
          email?: string
          email_id?: string | null
          id?: number
          received_at?: string
          stage?: string | null
          subject?: string | null
        }
        Relationships: []
      }
      job_pool: {
        Row: {
          apply_url: string | null
          company: string | null
          compensation: string | null
          description: string | null
          employment_type: string | null
          first_seen: string | null
          id: string
          last_seen: string | null
          location: string | null
          posted_at: string | null
          remote: string | null
          segment: string | null
          slug: string | null
          source: string | null
          team: string | null
          title: string | null
        }
        Insert: {
          apply_url?: string | null
          company?: string | null
          compensation?: string | null
          description?: string | null
          employment_type?: string | null
          first_seen?: string | null
          id: string
          last_seen?: string | null
          location?: string | null
          posted_at?: string | null
          remote?: string | null
          segment?: string | null
          slug?: string | null
          source?: string | null
          team?: string | null
          title?: string | null
        }
        Update: {
          apply_url?: string | null
          company?: string | null
          compensation?: string | null
          description?: string | null
          employment_type?: string | null
          first_seen?: string | null
          id?: string
          last_seen?: string | null
          location?: string | null
          posted_at?: string | null
          remote?: string | null
          segment?: string | null
          slug?: string | null
          source?: string | null
          team?: string | null
          title?: string | null
        }
        Relationships: []
      }
      join_applicants: {
        Row: {
          created_at: string
          email: string
          last_msg_at: string | null
          redirect_count: number
          scores: Json | null
          stage: string
          transcript: Json
          turns: number
          updated_at: string
          verdict: string | null
          verdict_at: string | null
          verdict_by: string | null
        }
        Insert: {
          created_at?: string
          email: string
          last_msg_at?: string | null
          redirect_count?: number
          scores?: Json | null
          stage?: string
          transcript?: Json
          turns?: number
          updated_at?: string
          verdict?: string | null
          verdict_at?: string | null
          verdict_by?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          last_msg_at?: string | null
          redirect_count?: number
          scores?: Json | null
          stage?: string
          transcript?: Json
          turns?: number
          updated_at?: string
          verdict?: string | null
          verdict_at?: string | null
          verdict_by?: string | null
        }
        Relationships: []
      }
      match_verdicts: {
        Row: {
          cache_key: string
          email: string
          output: Json
          scored_at: string
        }
        Insert: {
          cache_key: string
          email: string
          output: Json
          scored_at?: string
        }
        Update: {
          cache_key?: string
          email?: string
          output?: Json
          scored_at?: string
        }
        Relationships: []
      }
      referral_lookups: {
        Row: {
          chosen: Json | null
          company: string | null
          contacts: Json
          created_at: string
          domain: string
          email: string
          id: number
          provider: string
        }
        Insert: {
          chosen?: Json | null
          company?: string | null
          contacts?: Json
          created_at?: string
          domain: string
          email: string
          id?: never
          provider?: string
        }
        Update: {
          chosen?: Json | null
          company?: string | null
          contacts?: Json
          created_at?: string
          domain?: string
          email?: string
          id?: never
          provider?: string
        }
        Relationships: []
      }
      representations: {
        Row: {
          candidate_email: string
          candidate_name: string | null
          channel: string | null
          company: string
          company_responded_at: string | null
          company_response: string | null
          created_at: string
          id: number
          interview_at: string | null
          job_id: string | null
          notes: string | null
          outcome: string
          outcome_at: string | null
          represented_at: string
          role_title: string
          updated_at: string
        }
        Insert: {
          candidate_email: string
          candidate_name?: string | null
          channel?: string | null
          company: string
          company_responded_at?: string | null
          company_response?: string | null
          created_at?: string
          id?: number
          interview_at?: string | null
          job_id?: string | null
          notes?: string | null
          outcome?: string
          outcome_at?: string | null
          represented_at?: string
          role_title: string
          updated_at?: string
        }
        Update: {
          candidate_email?: string
          candidate_name?: string | null
          channel?: string | null
          company?: string
          company_responded_at?: string | null
          company_response?: string | null
          created_at?: string
          id?: number
          interview_at?: string | null
          job_id?: string | null
          notes?: string | null
          outcome?: string
          outcome_at?: string | null
          represented_at?: string
          role_title?: string
          updated_at?: string
        }
        Relationships: []
      }
      scheduled_tasks: {
        Row: {
          created_at: string
          done_at: string | null
          email: string
          id: number
          kind: string
          payload: Json
          run_at: string
          status: string
        }
        Insert: {
          created_at?: string
          done_at?: string | null
          email: string
          id?: never
          kind: string
          payload?: Json
          run_at: string
          status?: string
        }
        Update: {
          created_at?: string
          done_at?: string | null
          email?: string
          id?: never
          kind?: string
          payload?: Json
          run_at?: string
          status?: string
        }
        Relationships: []
      }
      sent_emails: {
        Row: {
          body_text: string | null
          dedupe_key: string
          email: string
          id: number
          resend_id: string | null
          sent_at: string
          subject: string | null
          template: string
        }
        Insert: {
          body_text?: string | null
          dedupe_key: string
          email: string
          id?: never
          resend_id?: string | null
          sent_at?: string
          subject?: string | null
          template: string
        }
        Update: {
          body_text?: string | null
          dedupe_key?: string
          email?: string
          id?: never
          resend_id?: string | null
          sent_at?: string
          subject?: string | null
          template?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          created_at: string
          email: string
          event: string
          find_id: string | null
          id: number
          job_id: string | null
          meta: Json
        }
        Insert: {
          created_at?: string
          email: string
          event: string
          find_id?: string | null
          id?: never
          job_id?: string | null
          meta?: Json
        }
        Update: {
          created_at?: string
          email?: string
          event?: string
          find_id?: string | null
          id?: never
          job_id?: string | null
          meta?: Json
        }
        Relationships: []
      }
      suppressions: {
        Row: {
          address: string
          created_at: string
          reason: string
        }
        Insert: {
          address: string
          created_at?: string
          reason?: string
        }
        Update: {
          address?: string
          created_at?: string
          reason?: string
        }
        Relationships: []
      }
      talent_pool: {
        Row: {
          applied_at: string | null
          assessed_at: string | null
          assessed_family: string | null
          available_from: string | null
          avg_tenure_months: number | null
          city: string | null
          comp_currency: string | null
          comp_current: number | null
          comp_expected: number | null
          comp_expected_raw: string | null
          company_scale: string | null
          company_type: string | null
          company_typed_at: string | null
          completeness: number | null
          consent_pool: boolean | null
          consent_process: boolean | null
          consent_share: boolean | null
          consent_text: Json | null
          country: string | null
          created_at: string
          current_company: string | null
          current_tenure_months: number | null
          current_title: string | null
          degree: string | null
          dimensions: Json | null
          domains: string[] | null
          education_read_at: string | null
          email: string
          enriched_at: string | null
          enrichment_version: string | null
          evidence: Json | null
          full_name: string | null
          grad_year: number | null
          headline: string | null
          id: number
          institution: string | null
          institution_tier: string | null
          institution_tier_source: string | null
          linkedin_url: string | null
          longest_tenure_months: number | null
          missing_fields: string[] | null
          mobility_profile: string | null
          notice_days: number | null
          notice_period_raw: string | null
          offer_noted_at: string | null
          offer_status: string | null
          phone: string | null
          portfolio_url: string | null
          previous_company: string | null
          previous_title: string | null
          provenance: Json | null
          role_family: string | null
          roles_count: number | null
          screen_flags: string[] | null
          screen_max: number | null
          screen_score: number | null
          seeking_confirmed_at: string | null
          seeking_status: string | null
          seeking_until: string | null
          seniority: string | null
          shortlisted: boolean | null
          signals: Json | null
          signals_read_at: string | null
          source_form: string | null
          source_role: string | null
          standout: string | null
          story_candidate: string | null
          story_client: string | null
          top_skills: string[] | null
          total_years: number | null
          updated_at: string
          willing_to_relocate: string | null
          work_mode_pref: string | null
        }
        Insert: {
          applied_at?: string | null
          assessed_at?: string | null
          assessed_family?: string | null
          available_from?: string | null
          avg_tenure_months?: number | null
          city?: string | null
          comp_currency?: string | null
          comp_current?: number | null
          comp_expected?: number | null
          comp_expected_raw?: string | null
          company_scale?: string | null
          company_type?: string | null
          company_typed_at?: string | null
          completeness?: number | null
          consent_pool?: boolean | null
          consent_process?: boolean | null
          consent_share?: boolean | null
          consent_text?: Json | null
          country?: string | null
          created_at?: string
          current_company?: string | null
          current_tenure_months?: number | null
          current_title?: string | null
          degree?: string | null
          dimensions?: Json | null
          domains?: string[] | null
          education_read_at?: string | null
          email: string
          enriched_at?: string | null
          enrichment_version?: string | null
          evidence?: Json | null
          full_name?: string | null
          grad_year?: number | null
          headline?: string | null
          id?: number
          institution?: string | null
          institution_tier?: string | null
          institution_tier_source?: string | null
          linkedin_url?: string | null
          longest_tenure_months?: number | null
          missing_fields?: string[] | null
          mobility_profile?: string | null
          notice_days?: number | null
          notice_period_raw?: string | null
          offer_noted_at?: string | null
          offer_status?: string | null
          phone?: string | null
          portfolio_url?: string | null
          previous_company?: string | null
          previous_title?: string | null
          provenance?: Json | null
          role_family?: string | null
          roles_count?: number | null
          screen_flags?: string[] | null
          screen_max?: number | null
          screen_score?: number | null
          seeking_confirmed_at?: string | null
          seeking_status?: string | null
          seeking_until?: string | null
          seniority?: string | null
          shortlisted?: boolean | null
          signals?: Json | null
          signals_read_at?: string | null
          source_form?: string | null
          source_role?: string | null
          standout?: string | null
          story_candidate?: string | null
          story_client?: string | null
          top_skills?: string[] | null
          total_years?: number | null
          updated_at?: string
          willing_to_relocate?: string | null
          work_mode_pref?: string | null
        }
        Update: {
          applied_at?: string | null
          assessed_at?: string | null
          assessed_family?: string | null
          available_from?: string | null
          avg_tenure_months?: number | null
          city?: string | null
          comp_currency?: string | null
          comp_current?: number | null
          comp_expected?: number | null
          comp_expected_raw?: string | null
          company_scale?: string | null
          company_type?: string | null
          company_typed_at?: string | null
          completeness?: number | null
          consent_pool?: boolean | null
          consent_process?: boolean | null
          consent_share?: boolean | null
          consent_text?: Json | null
          country?: string | null
          created_at?: string
          current_company?: string | null
          current_tenure_months?: number | null
          current_title?: string | null
          degree?: string | null
          dimensions?: Json | null
          domains?: string[] | null
          education_read_at?: string | null
          email?: string
          enriched_at?: string | null
          enrichment_version?: string | null
          evidence?: Json | null
          full_name?: string | null
          grad_year?: number | null
          headline?: string | null
          id?: number
          institution?: string | null
          institution_tier?: string | null
          institution_tier_source?: string | null
          linkedin_url?: string | null
          longest_tenure_months?: number | null
          missing_fields?: string[] | null
          mobility_profile?: string | null
          notice_days?: number | null
          notice_period_raw?: string | null
          offer_noted_at?: string | null
          offer_status?: string | null
          phone?: string | null
          portfolio_url?: string | null
          previous_company?: string | null
          previous_title?: string | null
          provenance?: Json | null
          role_family?: string | null
          roles_count?: number | null
          screen_flags?: string[] | null
          screen_max?: number | null
          screen_score?: number | null
          seeking_confirmed_at?: string | null
          seeking_status?: string | null
          seeking_until?: string | null
          seniority?: string | null
          shortlisted?: boolean | null
          signals?: Json | null
          signals_read_at?: string | null
          source_form?: string | null
          source_role?: string | null
          standout?: string | null
          story_candidate?: string | null
          story_client?: string | null
          top_skills?: string[] | null
          total_years?: number | null
          updated_at?: string
          willing_to_relocate?: string | null
          work_mode_pref?: string | null
        }
        Relationships: []
      }
      vv_agent_versions: {
        Row: {
          controller_version: string
          created_at: string
          elevenlabs_agent_id: string | null
          evaluator_version: string
          extractor_prompt_version: string
          id: string
          judge_prompt_version: string
          writer_prompt_version: string
        }
        Insert: {
          controller_version: string
          created_at?: string
          elevenlabs_agent_id?: string | null
          evaluator_version: string
          extractor_prompt_version: string
          id?: string
          judge_prompt_version: string
          writer_prompt_version: string
        }
        Update: {
          controller_version?: string
          created_at?: string
          elevenlabs_agent_id?: string | null
          evaluator_version?: string
          extractor_prompt_version?: string
          id?: string
          judge_prompt_version?: string
          writer_prompt_version?: string
        }
        Relationships: []
      }
      vv_candidates: {
        Row: {
          created_at: string
          cv_ref: string | null
          email: string
          id: string
          name_as_given: string | null
        }
        Insert: {
          created_at?: string
          cv_ref?: string | null
          email: string
          id?: string
          name_as_given?: string | null
        }
        Update: {
          created_at?: string
          cv_ref?: string | null
          email?: string
          id?: string
          name_as_given?: string | null
        }
        Relationships: []
      }
      vv_consents: {
        Row: {
          granted: boolean
          id: string
          recorded_at: string
          scope: string
          session_id: string
          text_version: string
          user_agent: string | null
        }
        Insert: {
          granted: boolean
          id?: string
          recorded_at?: string
          scope: string
          session_id: string
          text_version: string
          user_agent?: string | null
        }
        Update: {
          granted?: boolean
          id?: string
          recorded_at?: string
          scope?: string
          session_id?: string
          text_version?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vv_consents_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_contradictions: {
        Row: {
          created_at: string
          cv_line: string | null
          evidence_a: string
          evidence_b: string | null
          field: string
          id: string
          plan_item_id: string | null
          requirement_id: string | null
          resolution_evidence: string | null
          resolved: boolean
          session_id: string
        }
        Insert: {
          created_at?: string
          cv_line?: string | null
          evidence_a: string
          evidence_b?: string | null
          field: string
          id?: string
          plan_item_id?: string | null
          requirement_id?: string | null
          resolution_evidence?: string | null
          resolved?: boolean
          session_id: string
        }
        Update: {
          created_at?: string
          cv_line?: string | null
          evidence_a?: string
          evidence_b?: string | null
          field?: string
          id?: string
          plan_item_id?: string | null
          requirement_id?: string | null
          resolution_evidence?: string | null
          resolved?: boolean
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vv_contradictions_evidence_a_fkey"
            columns: ["evidence_a"]
            isOneToOne: false
            referencedRelation: "vv_evidence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_contradictions_evidence_b_fkey"
            columns: ["evidence_b"]
            isOneToOne: false
            referencedRelation: "vv_evidence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_contradictions_plan_item_id_fkey"
            columns: ["plan_item_id"]
            isOneToOne: false
            referencedRelation: "vv_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_contradictions_requirement_id_fkey"
            columns: ["requirement_id"]
            isOneToOne: false
            referencedRelation: "vv_requirements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_contradictions_resolution_evidence_fkey"
            columns: ["resolution_evidence"]
            isOneToOne: false
            referencedRelation: "vv_evidence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_contradictions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_conversations: {
        Row: {
          audio_ref: string | null
          end_reason: string | null
          ended_at: string | null
          id: string
          provider_conversation_id: string
          raw_payload_ref: string | null
          session_id: string
          started_at: string
          transcript_hash: string | null
        }
        Insert: {
          audio_ref?: string | null
          end_reason?: string | null
          ended_at?: string | null
          id?: string
          provider_conversation_id: string
          raw_payload_ref?: string | null
          session_id: string
          started_at?: string
          transcript_hash?: string | null
        }
        Update: {
          audio_ref?: string | null
          end_reason?: string | null
          ended_at?: string | null
          id?: string
          provider_conversation_id?: string
          raw_payload_ref?: string | null
          session_id?: string
          started_at?: string
          transcript_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vv_conversations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_disputes: {
        Row: {
          created_at: string
          id: string
          reason: string
          session_id: string
          turn_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason: string
          session_id: string
          turn_id: string
        }
        Update: {
          created_at?: string
          id?: string
          reason?: string
          session_id?: string
          turn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vv_disputes_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_disputes_turn_id_fkey"
            columns: ["turn_id"]
            isOneToOne: false
            referencedRelation: "vv_turns"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_events: {
        Row: {
          at: string
          id: number
          kind: string
          payload: Json
          session_id: string
          type: string
        }
        Insert: {
          at?: string
          id?: number
          kind: string
          payload?: Json
          session_id: string
          type: string
        }
        Update: {
          at?: string
          id?: number
          kind?: string
          payload?: Json
          session_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "vv_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_evidence: {
        Row: {
          contract_element: string
          created_at: string
          extractor_version: string
          id: string
          ownership: string
          plan_item_id: string
          probe_depth: number
          provenance: Json
          quote: string
          reliability: string
          requirement_id: string | null
          session_id: string
          specificity: number
          type: string
          typed_facts: Json
        }
        Insert: {
          contract_element: string
          created_at?: string
          extractor_version: string
          id?: string
          ownership: string
          plan_item_id: string
          probe_depth: number
          provenance: Json
          quote: string
          reliability: string
          requirement_id?: string | null
          session_id: string
          specificity: number
          type: string
          typed_facts?: Json
        }
        Update: {
          contract_element?: string
          created_at?: string
          extractor_version?: string
          id?: string
          ownership?: string
          plan_item_id?: string
          probe_depth?: number
          provenance?: Json
          quote?: string
          reliability?: string
          requirement_id?: string | null
          session_id?: string
          specificity?: number
          type?: string
          typed_facts?: Json
        }
        Relationships: [
          {
            foreignKeyName: "vv_evidence_plan_item_id_fkey"
            columns: ["plan_item_id"]
            isOneToOne: false
            referencedRelation: "vv_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_evidence_requirement_id_fkey"
            columns: ["requirement_id"]
            isOneToOne: false
            referencedRelation: "vv_requirements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_evidence_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_invitations: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          opened_at: string | null
          revoked_at: string | null
          sent_at: string | null
          session_id: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          opened_at?: string | null
          revoked_at?: string | null
          sent_at?: string | null
          session_id: string
          token_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          opened_at?: string | null
          revoked_at?: string | null
          sent_at?: string | null
          session_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "vv_invitations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_mandates: {
        Row: {
          client: string | null
          contact_email: string
          created_at: string
          dropped: Json | null
          hr_questions: Json
          id: string
          jd_text: string
          next_step_text: string | null
          parsed: Json | null
          role: string
          status: string
        }
        Insert: {
          client?: string | null
          contact_email: string
          created_at?: string
          dropped?: Json | null
          hr_questions?: Json
          id?: string
          jd_text: string
          next_step_text?: string | null
          parsed?: Json | null
          role: string
          status?: string
        }
        Update: {
          client?: string | null
          contact_email?: string
          created_at?: string
          dropped?: Json | null
          hr_questions?: Json
          id?: string
          jd_text?: string
          next_step_text?: string | null
          parsed?: Json | null
          role?: string
          status?: string
        }
        Relationships: []
      }
      vv_plan_items: {
        Row: {
          budget_seconds: number
          created_at: string
          evidence_contract: Json
          id: string
          kind: string
          plan_id: string
          priority: number
          ref: string
          requirement_id: string | null
        }
        Insert: {
          budget_seconds: number
          created_at?: string
          evidence_contract: Json
          id?: string
          kind: string
          plan_id: string
          priority: number
          ref: string
          requirement_id?: string | null
        }
        Update: {
          budget_seconds?: number
          created_at?: string
          evidence_contract?: Json
          id?: string
          kind?: string
          plan_id?: string
          priority?: number
          ref?: string
          requirement_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vv_plan_items_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "vv_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_plan_items_requirement_id_fkey"
            columns: ["requirement_id"]
            isOneToOne: false
            referencedRelation: "vv_requirements"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_plans: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          consent_text_version: string | null
          created_at: string
          flagged: Json
          id: string
          mandate_id: string
          override_reason: string | null
          session_budget_seconds: number
          status: string
          version: number
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          consent_text_version?: string | null
          created_at?: string
          flagged?: Json
          id?: string
          mandate_id: string
          override_reason?: string | null
          session_budget_seconds: number
          status?: string
          version: number
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          consent_text_version?: string | null
          created_at?: string
          flagged?: Json
          id?: string
          mandate_id?: string
          override_reason?: string | null
          session_budget_seconds?: number
          status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "vv_plans_mandate_id_fkey"
            columns: ["mandate_id"]
            isOneToOne: false
            referencedRelation: "vv_mandates"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_reports: {
        Row: {
          created_at: string
          id: string
          package: Json
          released_at: string | null
          rendered_ref: string | null
          reviewed_by: string | null
          session_id: string
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          package: Json
          released_at?: string | null
          rendered_ref?: string | null
          reviewed_by?: string | null
          session_id: string
          version: number
        }
        Update: {
          created_at?: string
          id?: string
          package?: Json
          released_at?: string | null
          rendered_ref?: string | null
          reviewed_by?: string | null
          session_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "vv_reports_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_requirements: {
        Row: {
          created_at: string
          evidence_needed: string | null
          id: string
          kind: string
          mandate_id: string
          observable: Json | null
          quote: string
          ref: string
          skill_cluster_id: string | null
          text: string
        }
        Insert: {
          created_at?: string
          evidence_needed?: string | null
          id?: string
          kind: string
          mandate_id: string
          observable?: Json | null
          quote: string
          ref: string
          skill_cluster_id?: string | null
          text: string
        }
        Update: {
          created_at?: string
          evidence_needed?: string | null
          id?: string
          kind?: string
          mandate_id?: string
          observable?: Json | null
          quote?: string
          ref?: string
          skill_cluster_id?: string | null
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "vv_requirements_mandate_id_fkey"
            columns: ["mandate_id"]
            isOneToOne: false
            referencedRelation: "vv_mandates"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_reviews: {
        Row: {
          evidence_lift: Json
          id: string
          per_signal: Json
          recorded_at: string
          report_version: number
          reviewer: string
          session_id: string
        }
        Insert: {
          evidence_lift?: Json
          id?: string
          per_signal: Json
          recorded_at?: string
          report_version: number
          reviewer: string
          session_id: string
        }
        Update: {
          evidence_lift?: Json
          id?: string
          per_signal?: Json
          recorded_at?: string
          report_version?: number
          reviewer?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vv_reviews_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_sessions: {
        Row: {
          candidate_id: string | null
          completed_at: string | null
          conditions: Json
          created_at: string
          cursor: Json
          id: string
          kind: string
          plan_id: string
          started_at: string | null
          state: string
          tester_email: string | null
          updated_at: string
          version: number
        }
        Insert: {
          candidate_id?: string | null
          completed_at?: string | null
          conditions?: Json
          created_at?: string
          cursor?: Json
          id?: string
          kind: string
          plan_id: string
          started_at?: string | null
          state?: string
          tester_email?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          candidate_id?: string | null
          completed_at?: string | null
          conditions?: Json
          created_at?: string
          cursor?: Json
          id?: string
          kind?: string
          plan_id?: string
          started_at?: string | null
          state?: string
          tester_email?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "vv_sessions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "vv_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_sessions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "vv_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_signals: {
        Row: {
          basis: string
          category: string
          coverage_band: string
          coverage_inputs: Json
          created_at: string
          evaluator_version: string
          evidence_ids: string[]
          id: string
          limitations: string[]
          plan_item_id: string | null
          reason: string | null
          requirement_id: string | null
          session_id: string
          status: string
        }
        Insert: {
          basis: string
          category: string
          coverage_band: string
          coverage_inputs: Json
          created_at?: string
          evaluator_version: string
          evidence_ids?: string[]
          id?: string
          limitations?: string[]
          plan_item_id?: string | null
          reason?: string | null
          requirement_id?: string | null
          session_id: string
          status: string
        }
        Update: {
          basis?: string
          category?: string
          coverage_band?: string
          coverage_inputs?: Json
          created_at?: string
          evaluator_version?: string
          evidence_ids?: string[]
          id?: string
          limitations?: string[]
          plan_item_id?: string | null
          reason?: string | null
          requirement_id?: string | null
          session_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "vv_signals_plan_item_id_fkey"
            columns: ["plan_item_id"]
            isOneToOne: false
            referencedRelation: "vv_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_signals_requirement_id_fkey"
            columns: ["requirement_id"]
            isOneToOne: false
            referencedRelation: "vv_requirements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_signals_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "vv_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      vv_turns: {
        Row: {
          conversation_id: string
          id: string
          move: string | null
          plan_item_id: string | null
          seq: number
          speaker: string
          stt_confidence: number | null
          superseded_by: string | null
          t_end: number | null
          t_start: number | null
          text: string
          usable: boolean
        }
        Insert: {
          conversation_id: string
          id?: string
          move?: string | null
          plan_item_id?: string | null
          seq: number
          speaker: string
          stt_confidence?: number | null
          superseded_by?: string | null
          t_end?: number | null
          t_start?: number | null
          text: string
          usable?: boolean
        }
        Update: {
          conversation_id?: string
          id?: string
          move?: string | null
          plan_item_id?: string | null
          seq?: number
          speaker?: string
          stt_confidence?: number | null
          superseded_by?: string | null
          t_end?: number | null
          t_start?: number | null
          text?: string
          usable?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "vv_turns_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "vv_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_turns_plan_item_id_fkey"
            columns: ["plan_item_id"]
            isOneToOne: false
            referencedRelation: "vv_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vv_turns_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "vv_turns"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          created_at: string
          email: string | null
          id: number
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: number
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: number
        }
        Relationships: []
      }
    }
    Views: {
      v_role_intent: {
        Row: {
          email: string | null
          find_id: string | null
          intent_label: string | null
          intent_level: number | null
          status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finds_email_fkey"
            columns: ["email"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["email"]
          },
        ]
      }
    }
    Functions: {
      hire_pursuit_apply: {
        Args: {
          p_event: Json
          p_expected_seq: number
          p_id: string
          p_new_keys: string[]
          p_row: Json
        }
        Returns: number
      }
      hire_pursuit_create: {
        Args: { p_event: Json; p_row: Json }
        Returns: string
      }
      hire_work_claim: {
        Args: {
          p_kind: string
          p_lease_seconds: number
          p_limit: number
          p_worker: string
        }
        Returns: {
          attempts: number
          company: string | null
          created_at: string
          id: string
          key: string
          kind: string
          last_error: string | null
          lease_until: string | null
          leased_by: string | null
          max_attempts: number
          payload: Json
          result: Json | null
          run_after: string
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "hire_work"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
