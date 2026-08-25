fn count(haystack: &str, needle: &str) -> usize {
    haystack.match_indices(needle).count()
}

#[test]
fn relay_members_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/relay_members.rs");

    for method in [
        "is_relay_member",
        "get_relay_member",
        "list_relay_members",
        "add_relay_member",
        "claim_relay_membership",
        "has_join_policy_acceptance",
        "remove_relay_member",
        "remove_relay_member_if_role",
        "update_relay_member_role",
        "bootstrap_owner",
        "has_admin_or_owner",
        "transfer_ownership",
        "backfill_from_allowlist",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db method and one SQL function in relay_members.rs"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(store, &span), 1, "{method} span is not unique");
    }

    for method in [
        "nip43_membership_snapshot_needs_reconciliation",
        "publish_nip43_membership_locked",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            1,
            "{method} must be singly owned by relay_members.rs"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(store, &span), 1, "{method} span is not unique");
    }

    assert_eq!(
        count(
            root,
            "async fn is_relay_member_is_bounded_routed_and_fails_closed("
        ),
        1,
        "the cross-cutting route proof must remain in lib.rs"
    );
    assert_eq!(
        count(
            store,
            "async fn is_relay_member_is_bounded_routed_and_fails_closed("
        ),
        0,
        "the cross-cutting route proof must not move into the domain store"
    );
}

#[test]
fn relay_invite_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/relay_invite.rs");

    for method in [
        "mint_relay_invite",
        "reap_expired_relay_invites",
        "claim_relay_invite",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db method and one SQL function in relay_invite.rs"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(store, &span), 1, "{method} span is not unique");
    }

    for ty in ["pub enum ClaimOutcome", "pub struct MintedInvite"] {
        assert_eq!(count(root, ty), 0, "{ty} remains in lib.rs");
        assert_eq!(count(store, ty), 1, "{ty} is not singly owned");
    }
}

#[test]
fn product_feedback_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/product_feedback.rs");

    for method in ["insert_product_feedback", "list_product_feedback"] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            1,
            "{method} must be singly owned by product_feedback.rs"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(store, &span), 1, "{method} span is not unique");
    }

    for ty in [
        "pub struct NewProductFeedback",
        "pub struct ProductFeedbackRecord",
    ] {
        assert_eq!(count(root, ty), 0, "{ty} remains in lib.rs");
        assert_eq!(count(store, ty), 1, "{ty} is not singly owned");
    }
}

#[test]
fn moderation_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/moderation.rs");

    for method in [
        "insert_moderation_report",
        "list_moderation_reports",
        "get_moderation_report",
        "get_moderation_report_by_event",
        "resolve_moderation_report",
        "ban_community_member",
        "unban_community_member",
        "timeout_community_member",
        "untimeout_community_member",
        "moderation_restriction_state",
        "get_community_ban",
        "list_community_restrictions",
        "insert_moderation_action",
        "list_moderation_actions",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            1,
            "{method} must be singly owned by moderation.rs"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(store, &span), 1, "{method} span is not unique");
    }

    for ty in [
        "pub enum ReportTarget",
        "pub struct NewReport",
        "pub struct ReportRecord",
        "pub struct BanRecord",
        "pub struct RestrictionState",
        "pub struct NewAction",
        "pub struct ActionRecord",
    ] {
        assert_eq!(count(root, ty), 0, "{ty} remains in lib.rs");
        assert_eq!(count(store, ty), 1, "{ty} is not singly owned");
    }
}

#[test]
fn channel_and_membership_stores_have_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let channels = include_str!("../src/channel.rs");
    let members = include_str!("../src/channel_members.rs");

    for method in [
        "create_channel",
        "create_channel_with_id",
        "get_channel",
        "get_canvas",
        "set_canvas",
        "list_channels",
        "update_channel",
        "set_topic",
        "set_purpose",
        "archive_channel",
        "unarchive_channel",
        "soft_delete_channel",
        "reap_expired_ephemeral_channels",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(channels, &signature),
            2,
            "{method} must have one Db method and one SQL function in channel.rs"
        );
        assert_eq!(
            count(members, &signature),
            0,
            "{method} leaked into membership"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(channels, &span), 1, "{method} span is not unique");
    }

    for method in [
        "verify_channel_roster_fence",
        "lock_member_snapshot",
        "add_member",
        "remove_member",
        "is_member",
        "membership_pairs",
        "get_members",
        "get_members_bulk",
        "get_accessible_channel_ids",
        "list_large_channel_rosters_needing_reconciliation",
        "get_accessible_channels",
        "get_bot_members",
        "get_users_bulk",
        "get_member_count",
        "get_member_counts_bulk",
        "get_member_role",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        let expected = if method == "verify_channel_roster_fence" {
            1
        } else {
            2
        };
        assert_eq!(
            count(members, &signature),
            expected,
            "{method} must be singly owned by channel_members.rs"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(members, &span), 1, "{method} span is not unique");
    }

    for ty in [
        "MemberRecord",
        "LockedMemberSnapshot",
        "LargeChannelRoster",
        "AccessibleChannel",
        "BotChannelEntry",
        "BotMemberRecord",
        "UserRecord",
    ] {
        assert_eq!(count(root, &format!("struct {ty}")), 0);
        assert_eq!(
            count(members, &format!("struct {ty}")),
            1,
            "{ty} is not singly owned"
        );
    }

    for test_name in [
        "unmigrated_roster_fence_blocks_startup_until_0032_is_applied",
        "channel_roster_fence_behavior_verification_detects_inert_function",
        "channel_roster_fence_catalog_verification_fails_closed",
        "desired_schema_rejects_stale_legacy_roster_role",
    ] {
        assert_eq!(
            count(root, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in lib.rs"
        );
        assert_eq!(
            count(members, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly owned"
        );
    }

    for ty in ["ChannelRecord", "ChannelUpdate", "ReapedEphemeralChannel"] {
        assert_eq!(
            count(channels, &format!("struct {ty}")),
            1,
            "{ty} is not singly owned"
        );
        assert_eq!(
            count(members, &format!("struct {ty}")),
            0,
            "{ty} leaked into membership"
        );
    }

    for test_name in [
        "get_channel_is_scoped_when_channel_uuid_collides_across_communities",
        "test_unarchive_expired_ephemeral_channel_renews_ttl_deadline",
        "reap_expired_ephemeral_channels_returns_row_community_and_host",
    ] {
        assert_eq!(
            count(root, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in lib.rs"
        );
        assert_eq!(
            count(channels, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly owned"
        );
        assert_eq!(
            count(members, &format!("async fn {test_name}(")),
            0,
            "{test_name} leaked into membership"
        );
    }

    for test_name in [
        "get_users_bulk_is_scoped_when_pubkey_exists_in_multiple_communities",
        "test_agent_owner_can_remove_bot",
        "accessible_channel_ids_are_not_truncated_at_one_thousand",
        "get_members_returns_full_roster_beyond_1000",
        "large_roster_reconciliation_candidates_respect_snapshot_count_and_signer",
        "test_random_user_cannot_remove_bot",
        "repro_unprivileged_member_can_demote_owner",
        "repro_private_channel_member_can_demote_owner",
        "owner_can_still_manage_roles_after_demotion_guard",
        "unprivileged_member_cannot_demote_a_co_owner",
        "locked_member_snapshot_blocks_post_capture_membership_mutation",
        "membership_writes_serialize_on_the_shared_channel_lock",
        "remove_member_rejects_an_actor_demoted_while_it_waited",
        "kicked_owner_rejoins_as_member_not_owner",
        "removed_owner_is_restored_only_by_a_current_owner",
    ] {
        assert_eq!(
            count(root, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in lib.rs"
        );
        assert_eq!(
            count(channels, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in channel.rs"
        );
        assert_eq!(
            count(members, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly owned"
        );
    }
}

#[test]
fn api_token_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/api_token.rs");

    for method in [
        "create_api_token",
        "create_api_token_if_under_limit",
        "get_api_token_by_hash_including_revoked",
        "list_tokens_by_owner",
        "revoke_token",
        "revoke_all_tokens",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} lacks Db or SQL ownership"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for method in [
        "get_api_token_by_hash",
        "touch_api_token",
        "list_active_tokens",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(store, &signature), 1, "{method} is not singly owned");
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "pub async fn update_token_last_used("), 0);
    assert_eq!(count(store, "pub async fn update_token_last_used("), 1);
    assert_eq!(
        count(store, "name = \"update_token_last_used\""),
        0,
        "alias must reuse the touch span"
    );

    for ty in ["ApiTokenRecord", "TokenSummary"] {
        assert_eq!(
            count(root, &format!("struct {ty}")),
            0,
            "{ty} remains in lib.rs"
        );
        assert_eq!(
            count(store, &format!("struct {ty}")),
            1,
            "{ty} is not singly owned"
        );
    }
    assert_eq!(count(root, "fn parse_api_token_row("), 0);
    assert_eq!(count(store, "fn parse_api_token_row("), 1);
}

#[test]
fn allowlist_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/allowlist.rs");

    for method in [
        "is_pubkey_allowed",
        "has_allowlist_entries",
        "add_to_allowlist",
        "remove_from_allowlist",
        "list_allowlist",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(store, &signature), 1, "{method} is not singly owned");
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "struct AllowlistEntry"), 0);
    assert_eq!(count(store, "struct AllowlistEntry"), 1);
    assert_eq!(count(root, "async fn allowlist_is_scoped_to_community("), 0);
    assert_eq!(
        count(store, "async fn allowlist_is_scoped_to_community("),
        1
    );
    assert_eq!(
        count(store, "backfill_from_allowlist"),
        0,
        "NIP-43 backfill must remain relay-membership owned"
    );
}

#[test]
fn reminder_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let events = include_str!("../src/event.rs");
    let store = include_str!("../src/reminder.rs");

    for method in [
        "query_due_reminders",
        "claim_due_reminder",
        "claim_due_reminder_with_stamp",
        "release_due_reminder",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(events, &signature), 0, "{method} remains in event.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one SQL function"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(events, "struct DueReminder"), 0);
    assert_eq!(count(store, "struct DueReminder"), 1);

    for test_name in [
        "query_due_reminders_returns_row_community_and_host_per_tenant",
        "claim_due_reminder_is_won_by_exactly_one_of_two_racing_pods",
        "release_due_reminder_rolls_back_only_the_matching_stamp",
        "reminder_claim_and_release_are_confined_to_their_community",
    ] {
        assert_eq!(
            count(events, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in event.rs"
        );
        assert_eq!(
            count(store, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly owned"
        );
    }

    assert_eq!(
        count(events, "pub fn extract_not_before("),
        1,
        "event insertion must retain reminder tag materialization"
    );
    assert_eq!(count(store, "pub fn extract_not_before("), 0);
}

#[test]
fn event_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/event.rs");

    for method in [
        "insert_event",
        "query_events",
        "count_events",
        "huddle_started_link_exists",
        "get_latest_global_replaceable",
        "get_event_by_id",
        "get_event_by_id_including_deleted",
        "soft_delete_event",
        "soft_delete_by_coordinate",
        "soft_delete_event_and_update_thread",
        "get_last_message_at",
        "get_last_message_at_bulk",
        "get_events_by_ids",
        "insert_event_with_thread_metadata",
    ] {
        let signature = format!("pub async fn {method}(");
        let expected_root = if method == "query_events" { 1 } else { 0 };
        assert_eq!(
            count(root, &signature),
            expected_root,
            "{method} Db wrapper remains in lib.rs"
        );
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one event SQL function"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for method in [
        "query_events_routed",
        "query_events_routed_bounded",
        "count_events_routed",
        "get_events_by_ids_routed",
        "soft_delete_discovery_events",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(store, &signature), 1, "{method} is not singly owned");
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(
        count(
            root,
            "async fn coordinate_delete_spares_head_newer_than_the_deletion("
        ),
        0
    );
    assert_eq!(
        count(
            store,
            "async fn coordinate_delete_spares_head_newer_than_the_deletion("
        ),
        1
    );

    assert_eq!(count(root, "async fn route_read("), 1);
    assert_eq!(count(store, "async fn route_read("), 0);
    assert_eq!(count(root, "pub async fn insert_mentions("), 1);
    assert_eq!(count(store, "pub async fn insert_mentions("), 0);
}

#[test]
fn thread_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/thread.rs");

    for method in [
        "insert_thread_metadata",
        "get_thread_replies",
        "get_thread_summary",
        "get_channel_window",
        "get_thread_metadata_by_event",
        "decrement_reply_count",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one thread SQL function"
        );
    }

    assert_eq!(
        count(root, "pub async fn get_channel_window_with_session("),
        0
    );
    assert_eq!(
        count(store, "pub async fn get_channel_window_with_session("),
        1
    );

    for span in [
        "insert_thread_metadata",
        "get_thread_replies",
        "get_thread_summary",
        "get_channel_window",
        "get_thread_metadata_by_event",
        "decrement_reply_count",
    ] {
        assert_eq!(
            count(store, &format!("name = \"{span}\"")),
            1,
            "{span} span is not unique"
        );
    }
    assert_eq!(
        count(store, "name = \"get_channel_window_with_session\""),
        0,
        "the convenience and session APIs must share one logical span"
    );

    assert_eq!(count(root, "async fn route_read("), 1);
    assert_eq!(count(store, "async fn route_read("), 0);
}

#[test]
fn reaction_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let events = include_str!("../src/event.rs");
    let store = include_str!("../src/reaction.rs");

    for method in [
        "insert_reaction_event_with_thread_metadata",
        "add_reaction",
        "remove_reaction",
        "remove_reaction_by_source_event_id",
        "get_active_reaction_record",
        "set_reaction_event_id",
        "get_reactions",
        "get_reactions_bulk",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(events, &signature), 0, "{method} remains in event.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one reaction SQL function"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "enum ReactionEventInsertOutcome"), 0);
    assert_eq!(count(events, "enum ReactionEventInsertOutcome"), 0);
    assert_eq!(count(store, "enum ReactionEventInsertOutcome"), 1);
    assert_eq!(count(events, "pub use crate::reaction::{"), 1);
    assert_eq!(
        count(events, "insert_reaction_event_with_thread_metadata"),
        1
    );
    assert_eq!(count(events, "ReactionEventInsertOutcome"), 1);
    assert_eq!(
        count(
            events,
            "pub(crate) async fn insert_event_with_thread_metadata_tx("
        ),
        1,
        "general event transaction primitive must remain event-owned"
    );

    for test_name in [
        "reaction_single_tx_stores_wrapped_max_shortcode",
        "reaction_single_tx_duplicate_short_circuit_stores_no_event",
        "reaction_single_tx_cross_community_target_rejected",
        "reaction_single_tx_event_insert_failure_rolls_back_reaction",
        "reaction_single_tx_reactivates_soft_deleted_reaction",
        "reactions_are_scoped_to_community",
    ] {
        assert_eq!(
            count(root, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in lib.rs"
        );
        assert_eq!(
            count(events, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in event.rs"
        );
        assert_eq!(
            count(store, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly reaction-owned"
        );
    }
}

#[test]
fn feed_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/feed.rs");

    for method in [
        "query_feed_mentions",
        "query_feed_mentions_routed",
        "query_feed_needs_action",
        "query_feed_needs_action_routed",
        "query_feed_activity",
        "query_feed_activity_routed",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(store, &signature), 1, "{method} is not singly owned");
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for sql_fn in ["query_mentions", "query_needs_action", "query_activity"] {
        assert_eq!(
            count(store, &format!("pub async fn {sql_fn}(")),
            1,
            "{sql_fn} SQL entry point is not singly feed-owned"
        );
    }

    assert_eq!(count(root, "async fn route_read("), 1);
    assert_eq!(count(store, "async fn route_read("), 0);
    assert_eq!(
        count(
            root,
            "async fn routed_reads_are_confined_to_the_requested_community("
        ),
        1,
        "cross-domain routing confinement must remain runtime-owned"
    );
}

#[test]
fn user_and_dm_stores_have_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let users = include_str!("../src/user.rs");
    let dms = include_str!("../src/dm.rs");

    for method in [
        "ensure_user",
        "get_user",
        "update_user_profile",
        "get_user_by_nip05",
        "search_users",
        "set_agent_owner",
        "get_agent_channel_policy",
        "is_agent_owner",
        "set_channel_add_policy",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(users, &signature),
            2,
            "{method} must have one Db wrapper and one user SQL function"
        );
        assert_eq!(count(dms, &signature), 0, "{method} leaked into dm.rs");
        assert_eq!(
            count(users, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for method in [
        "find_dm_by_participants",
        "create_dm",
        "list_dms_for_user",
        "open_dm",
        "hide_dm",
        "unhide_dm",
        "list_hidden_dms",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(users, &signature), 0, "{method} leaked into user.rs");
        assert_eq!(
            count(dms, &signature),
            2,
            "{method} must have one Db wrapper and one DM SQL function"
        );
        assert_eq!(
            count(dms, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for ty in ["UserProfile", "UserSearchProfile"] {
        assert_eq!(count(root, &format!("struct {ty}")), 0);
        assert_eq!(
            count(users, &format!("struct {ty}")),
            1,
            "{ty} is not singly user-owned"
        );
        assert_eq!(count(dms, &format!("struct {ty}")), 0);
    }

    for ty in ["DmRecord", "DmParticipant"] {
        assert_eq!(count(root, &format!("struct {ty}")), 0);
        assert_eq!(count(users, &format!("struct {ty}")), 0);
        assert_eq!(
            count(dms, &format!("struct {ty}")),
            1,
            "{ty} is not singly DM-owned"
        );
    }

    assert_eq!(count(root, "async fn route_read("), 1);
    assert_eq!(count(users, "async fn route_read("), 0);
    assert_eq!(count(dms, "async fn route_read("), 0);
}

#[test]
fn push_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/push.rs");

    for method in [
        "claim_due_push_match_batch",
        "active_push_match_leases",
        "complete_push_match_batch",
        "retry_push_match_batch",
        "reap_exhausted_push_matches",
        "enqueue_push_wake",
        "enqueue_push_wakes",
        "claim_due_push_wakes",
        "revalidate_push_wake",
        "complete_push_wake",
        "retry_push_wake",
        "fail_push_wake",
        "disable_push_endpoint",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(store, &signature), 1, "{method} is not singly owned");
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "pub async fn accept_push_lease_event("), 0);
    assert_eq!(
        count(store, "pub async fn accept_push_lease_event("),
        1,
        "accept_push_lease_event Db wrapper is not singly owned"
    );
    assert_eq!(count(store, "pub async fn accept_lease_event("), 1);
    assert_eq!(
        count(store, "name = \"accept_push_lease_event\""),
        1,
        "accept_push_lease_event span is not unique"
    );

    for ty in [
        "LeaseVersion",
        "ActiveLease",
        "ReplaceLeaseOutcome",
        "EnqueueWakeOutcome",
        "NewWake",
        "ClaimedWake",
        "RevalidateWakeOutcome",
        "MatchLease",
        "AcceptLeaseOutcome",
        "WakeRequest",
        "ClaimedMatchBatch",
        "BatchedMatch",
    ] {
        assert_eq!(count(root, &format!("struct {ty}")), 0);
        assert_eq!(count(root, &format!("enum {ty}")), 0);
        assert_eq!(
            count(store, &format!("struct {ty}")) + count(store, &format!("enum {ty}")),
            1,
            "{ty} is not singly push-owned"
        );
    }

    assert_eq!(
        count(root, "pub async fn insert_event_with_serving_write_guard("),
        1,
        "deletion serving-write orchestration must remain cross-domain"
    );
    assert_eq!(
        count(store, "pub async fn insert_event_with_serving_write_guard("),
        0
    );
    assert_eq!(count(root, "async fn route_read("), 1);
    assert_eq!(count(store, "async fn route_read("), 0);
}

#[test]
fn workflow_lifecycle_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/workflow.rs");

    for method in [
        "create_workflow",
        "upsert_workflow",
        "get_workflow",
        "list_channel_workflows",
        "list_enabled_channel_workflows",
        "list_all_enabled_workflows",
        "claim_scheduled_workflow_fire",
        "latest_scheduled_workflow_fire",
        "attach_scheduled_workflow_run",
        "prune_scheduled_workflow_fires_before",
        "update_workflow",
        "update_workflow_status",
        "set_workflow_enabled",
        "disable_workflows_for_owner_in_channel",
        "delete_workflow",
        "delete_workflow_for_owner",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one workflow SQL function"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(
        count(root, "pub async fn find_workflow_by_owner_and_name("),
        0
    );
    assert_eq!(
        count(store, "pub async fn find_workflow_by_owner_and_name("),
        1
    );
    assert_eq!(count(store, "pub async fn find_by_owner_and_name("), 1);
    assert_eq!(
        count(store, "name = \"find_workflow_by_owner_and_name\""),
        1
    );

    for ty in ["WorkflowRecord", "ScheduledWorkflowFireClaim"] {
        let declaration = format!("pub struct {ty} {{");
        assert_eq!(count(root, &declaration), 0);
        assert_eq!(count(store, &declaration), 1);
    }
    assert_eq!(count(root, "enum WorkflowStatus"), 0);
    assert_eq!(count(store, "enum WorkflowStatus"), 1);

    for method in [
        "create_workflow_run",
        "get_workflow_run",
        "list_workflow_runs",
        "list_workflow_runs_page",
        "update_workflow_run",
        "create_approval",
        "get_approval",
        "get_approval_by_stored_hash",
        "get_run_approvals",
        "update_approval",
        "update_approval_by_stored_hash",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one workflow SQL function"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for ty in [
        "WorkflowRunRecord",
        "WorkflowRunFailure",
        "ApprovalRecord",
        "CreateApprovalParams",
    ] {
        assert_eq!(count(root, &format!("struct {ty}")), 0);
        assert_eq!(count(store, &format!("struct {ty}")), 1);
    }
    for ty in ["RunStatus", "ApprovalStatus"] {
        assert_eq!(count(root, &format!("enum {ty}")), 0);
        assert_eq!(count(store, &format!("enum {ty}")), 1);
    }
}

#[test]
fn git_repo_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/git_repo.rs");

    for method in [
        "repo_name_owner",
        "reserve_repo_name",
        "count_repos_for_owner",
        "release_repo_name",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one git registry SQL function"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "enum ReserveOutcome"), 0);
    assert_eq!(count(store, "enum ReserveOutcome"), 1);
}

#[test]
fn archived_identities_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/archived_identities.rs");

    for method in ["is_archived", "archive", "unarchive", "list_archived"] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} must have one Db wrapper and one archived-identity SQL function"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "struct ArchivedIdentity"), 0);
    assert_eq!(count(store, "struct ArchivedIdentity"), 1);
}

#[test]
fn usage_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/usage.rs");

    for method in [
        "usage_community_count",
        "usage_user_counts",
        "usage_channel_counts",
        "usage_message_counts",
        "usage_relay_member_counts",
        "usage_workflow_counts",
        "usage_git_repo_counts",
        "usage_active_user_counts",
        "usage_active_channel_counts",
        "usage_community_hosts",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            1,
            "{method} Db wrapper is not unique"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "pub async fn try_lock_usage_metrics("), 0);
    assert_eq!(count(store, "pub async fn try_lock_usage_metrics("), 1);
    assert_eq!(count(store, "name = \"try_lock_usage_metrics\""), 1);
    assert_eq!(count(root, "struct UsageMetricsLeader"), 0);
    assert_eq!(count(store, "struct UsageMetricsLeader"), 1);
    assert_eq!(
        count(
            root,
            "test_usage_metrics_lock_has_single_owner_and_releases_on_drop"
        ),
        0
    );
    assert_eq!(
        count(
            store,
            "test_usage_metrics_lock_has_single_owner_and_releases_on_drop"
        ),
        1
    );
}

#[test]
fn admin_moderation_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/admin_moderation.rs");

    for method in [
        "admin_list_reports",
        "admin_get_report",
        "admin_list_feedback",
        "admin_get_feedback",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            1,
            "{method} Db wrapper is not unique"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for ty in [
        "AdminReport",
        "AdminReportedMessage",
        "AdminReportDetail",
        "AdminFeedback",
    ] {
        let declaration = format!("pub struct {ty} {{");
        assert_eq!(count(root, &declaration), 0);
        assert_eq!(count(store, &declaration), 1);
    }
}
