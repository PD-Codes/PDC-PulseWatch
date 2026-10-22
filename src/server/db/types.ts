import type { ColumnType, Generated } from 'kysely';

/** Timestamp with a database default. */
type Ts = Generated<Date>;
/** Nullable timestamp. */
type NTs = Date | null;
type Flag = Generated<number>; // TINYINT(1)
type Id = Generated<number>;

export interface UsersTable {
  id: Id; username: string; email: string | null; display_name: string; password_hash: string | null;
  role: Generated<'admin' | 'editor' | 'viewer'>; scope_restricted: Flag; auth_source: Generated<'local' | 'oidc' | 'ldap' | 'saml'>;
  external_id: string | null; locale: string | null; theme: Generated<'light' | 'dark' | 'system'>;
  totp_secret_enc: string | null; totp_enabled: Flag; totp_recovery: string | null; is_active: Flag;
  failed_logins: Generated<number>; locked_until: NTs; created_at: Ts; last_login_at: NTs;
}
export interface SessionsTable {
  id: Id; user_id: number; token_hash: string; created_at: Ts; last_seen_at: Ts; expires_at: Date; ip: string | null; user_agent: string | null;
}
export interface ApiTokensTable {
  id: Id; user_id: number; name: string; token_hash: string; token_prefix: string; scopes: Generated<string>;
  created_at: Ts; last_used_at: NTs; expires_at: NTs;
}
export interface PasskeysTable {
  id: Id; user_id: number; credential_id: string; public_key: string; counter: Generated<number>; transports: string | null; name: string; created_at: Ts;
}
export interface AuthProvidersTable { id: Id; kind: 'oidc' | 'ldap' | 'saml'; name: string; config_enc: string; enabled: Flag; created_at: Ts }
export interface SettingsTable { key: string; value: string; updated_at: Ts }
export interface AuditLogTable {
  id: Generated<number>; ts: Ts; user_id: number | null; actor: string; action: string; entity_type: string | null; entity_id: string | null; ip: string | null; details: string | null;
}
export interface MonitorGroupsTable { id: Id; parent_id: number | null; name: string; description: string | null; sort: Generated<number>; created_at: Ts }
export interface PermissionGrantsTable { id: Id; user_id: number; resource_type: 'monitor_group' | 'status_page'; resource_id: number; level: Generated<'view' | 'manage'> }
export interface ProbesTable {
  id: Id; name: string; location: string | null; token_hash: string; version: string | null; last_seen_at: NTs; last_ip: string | null; enabled: Flag; created_at: Ts;
}
export interface TagsTable { id: Id; name: string; color: Generated<string> }
export interface MonitorsTable {
  id: Id; name: string; type: string; group_id: number | null; description: string | null; config: string;
  interval_s: Generated<number>; timeout_s: Generated<number>; retries: Generated<number>; retry_interval_s: Generated<number>;
  up_threshold: Generated<number>; down_threshold: Generated<number>; flap_window: Generated<number>; flap_threshold: Generated<number>;
  active: Flag; locations: string | null; quorum: Generated<number>; push_token: string | null; public_badge: Flag;
  next_run_at: NTs; lease_owner: string | null; lease_until: NTs; attempt: Generated<number>;
  created_by: number | null; created_at: Ts; updated_at: Ts;
}
export interface MonitorTagsTable { monitor_id: number; tag_id: number; value: Generated<string> }
export interface MonitorDependenciesTable { monitor_id: number; depends_on_id: number }
export interface MonitorStateTable {
  monitor_id: number; status: Generated<'unknown' | 'up' | 'down' | 'pending'>; overlay: Generated<'none' | 'maintenance' | 'suppressed'>;
  status_since: NTs; consecutive_fail: Generated<number>; consecutive_ok: Generated<number>; last_check_at: NTs; last_latency_ms: number | null;
  last_error_kind: string | null; last_message: string | null; flapping: Flag; outcomes: Generated<string>; recent: string | null;
  cert_expires_at: NTs; cert_info: string | null; anomaly: string | null; last_push_at: NTs; updated_at: Ts;
}
export interface MonitorLocationStateTable {
  monitor_id: number; location_id: number; ok: number; ts: Date; latency_ms: number | null; error_kind: string | null; message: string | null;
}
export interface HeartbeatsTable {
  id: Generated<number>; monitor_id: number; location_id: Generated<number>; ts: Date; status: number; latency_ms: number | null; error_kind: string | null; message: string | null;
}
export interface RollupsTable {
  monitor_id: number; res: 'minute' | 'hour' | 'day'; bucket: Date; total: number; up_n: number; down_n: number; maint_n: Generated<number>;
  lat_n: Generated<number>; lat_sum: Generated<number>; lat_min: number | null; lat_max: number | null; lat_p50: number | null; lat_p95: number | null; lat_p99: number | null;
}
export interface EventsTable {
  id: Generated<number>; monitor_id: number | null; ts: Date; type: string; from_status: string | null; to_status: string | null;
  error_kind: string | null; message: string | null; details: string | null;
}
export interface SavedViewsTable { id: Id; user_id: number; name: string; filters: string; shared: Flag }
export type IncidentStatus = 'open' | 'acknowledged' | 'identified' | 'fixing' | 'monitoring' | 'resolved';
export interface IncidentsTable {
  id: Id; title: string; status: Generated<IncidentStatus>; severity: Generated<'minor' | 'major' | 'critical'>; source: Generated<'auto' | 'manual'>;
  monitor_id: number | null; started_at: Date; acknowledged_at: NTs; acknowledged_by: number | null; resolved_at: NTs; assignee_id: number | null;
  postmortem: string | null; public: Flag; hidden: Flag; created_by: number | null; created_at: Ts;
}
export interface IncidentMonitorsTable { incident_id: number; monitor_id: number }
export interface IncidentUpdatesTable { id: Id; incident_id: number; ts: Ts; user_id: number | null; kind: Generated<'note' | 'status' | 'ack' | 'assign' | 'resolve' | 'auto' | 'postmortem'>; status: IncidentStatus | null; body: string | null }
export interface MaintenanceWindowsTable {
  id: Id; name: string; description: string | null; kind: Generated<'once' | 'cron'>; starts_at: NTs; ends_at: NTs; cron_expr: string | null;
  duration_min: number | null; timezone: Generated<string>; active: Flag; announce: Flag; created_by: number | null; created_at: Ts;
}
export interface MaintenanceTargetsTable { window_id: number; target_type: 'monitor' | 'group' | 'tag'; target_id: number }
export interface StatusPagesTable {
  id: Id; slug: string; title: string; description: string | null; domain: string | null; is_public: Flag; password_hash: string | null; sso_required: Flag;
  branding: string | null; custom_css: string | null; blocks: string | null; show_history: Flag; history_days: Generated<number>; is_default: Flag; incident_days: Generated<number>; incident_page_size: Generated<number>; created_at: Ts;
}
export interface StatusPageSectionsTable { id: Id; page_id: number; name: string; sort: Generated<number> }
export interface StatusPageComponentsTable { id: Id; page_id: number; section_id: number | null; monitor_id: number; display_name: string | null; sort: Generated<number> }
export interface StatusPageAnnouncementsTable { id: Id; page_id: number; kind: Generated<'info' | 'maintenance' | 'incident'>; title: string; body: string | null; starts_at: Date; ends_at: NTs; created_at: Ts }
export interface StatusPageSubscribersTable { id: Id; page_id: number; kind: 'email' | 'webhook'; target_enc: string; target_hash: string; token: string; verified: Flag; created_at: Ts }
export interface NotificationTemplatesTable { id: Id; name: string; subject: string; body: string; created_at: Ts }
export interface NotificationChannelsTable {
  id: Id; name: string; type: string; config_enc: string; active: Generated<number>; is_default: Flag; quiet_hours: string | null; template_id: number | null; created_by: number | null; created_at: Ts;
}
export interface EscalationPoliciesTable { id: Id; name: string; steps: string; created_at: Ts }
export interface MonitorNotificationsTable { id: Id; monitor_id: number; channel_id: number | null; policy_id: number | null; events: Generated<string> }
export interface NotificationDeliveriesTable {
  id: Generated<number>; ts: Ts; channel_id: number | null; monitor_id: number | null; incident_id: number | null; event: string;
  status: Generated<'pending' | 'sent' | 'failed' | 'skipped'>; attempts: Generated<number>; next_attempt_at: NTs; last_error: string | null; subject: string | null; payload: string | null;
}
export interface EscalationRunsTable { id: Id; incident_id: number; monitor_id: number; policy_id: number; next_step: Generated<number>; next_at: Date; active: Generated<number> }
export interface ReportSchedulesTable {
  id: Id; name: string; scope_type: Generated<'all' | 'group' | 'monitor' | 'tag'>; scope_id: number | null; range_days: Generated<number>; cron_expr: string;
  timezone: Generated<string>; recipients: string; format: Generated<'pdf' | 'csv'>; enabled: Flag; last_run_at: NTs; created_by: number | null; created_at: Ts;
}

export interface CaCertsTable {
  id: Id; name: string; pem: string; subject: string; issuer: string; fingerprint256: string; valid_from: Ts; valid_to: Ts; created_by: number | null; created_at: Ts;
}

export interface DB {
  users: UsersTable; sessions: SessionsTable; api_tokens: ApiTokensTable; passkeys: PasskeysTable; auth_providers: AuthProvidersTable;
  settings: SettingsTable; audit_log: AuditLogTable; monitor_groups: MonitorGroupsTable; permission_grants: PermissionGrantsTable;
  probes: ProbesTable; tags: TagsTable; monitors: MonitorsTable; monitor_tags: MonitorTagsTable; monitor_dependencies: MonitorDependenciesTable;
  monitor_state: MonitorStateTable; monitor_location_state: MonitorLocationStateTable; heartbeats: HeartbeatsTable; rollups: RollupsTable;
  events: EventsTable; saved_views: SavedViewsTable; incidents: IncidentsTable; incident_monitors: IncidentMonitorsTable;
  incident_updates: IncidentUpdatesTable; maintenance_windows: MaintenanceWindowsTable; maintenance_targets: MaintenanceTargetsTable;
  status_pages: StatusPagesTable; status_page_sections: StatusPageSectionsTable; status_page_components: StatusPageComponentsTable;
  status_page_announcements: StatusPageAnnouncementsTable; status_page_subscribers: StatusPageSubscribersTable;
  notification_templates: NotificationTemplatesTable; notification_channels: NotificationChannelsTable; escalation_policies: EscalationPoliciesTable;
  monitor_notifications: MonitorNotificationsTable; notification_deliveries: NotificationDeliveriesTable; escalation_runs: EscalationRunsTable;
  report_schedules: ReportSchedulesTable; ca_certs: CaCertsTable;
}

export type { ColumnType };
